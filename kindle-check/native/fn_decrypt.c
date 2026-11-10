// fn_decrypt (copia para Passdroid): abre una bóveda .pdvault de Passdroid. Orden de campos de la cabecera idéntico al de FamilyNotes.
//   fn_decrypt bóveda.fnvault salida.json  (contraseña en la variable FN_PASSWORD o en --pass-file fichero)
//   fn_decrypt bóveda.fnvault salida.json --key clave.hex      (clave ya derivada: se salta Argon2, que es lo lento)
//   opción --save-key clave.hex  guarda la clave derivada (32 bytes en hex) para las siguientes sincronizaciones
// Formato (crypto.rs de FamilyNotes): JSON {"header":{...},"payload":"<base64>"}; Argon2id v1.3 (memoryKib, iterations,
// parallelism, salt base64, salida 32 B) -> XChaCha20-Poly1305 (nonce 24 B base64), tag de 16 B al final del cifrado y como
// datos asociados el JSON COMPACTO del encabezado reconstruido con el orden de campos de Rust (serde).
//
// Compilar:  arm-linux-gnueabi-gcc -static -O2 -Wall -o fn_decrypt fn_decrypt.c monocypher.c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <time.h>
#include "monocypher.h"

static long mono_ms(void) {
    struct timespec ts;
    if (syscall(SYS_clock_gettime, CLOCK_MONOTONIC, &ts) != 0) return 0;
    return (long)ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

static char *read_file(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 0 || n > 64L * 1024 * 1024) { fclose(f); return NULL; }
    char *buf = malloc((size_t)n + 1);
    if (!buf || fread(buf, 1, (size_t)n, f) != (size_t)n) { fclose(f); free(buf); return NULL; }
    fclose(f);
    buf[n] = 0;
    *len = (size_t)n;
    return buf;
}

// Valor de la clave `key` a partir de `from`: si es cadena devuelve su contenido (sin comillas, tal cual está escrito),
// si no, el texto hasta , } o espacio. Devuelve un malloc o NULL; `next` = dónde seguir buscando.
static char *json_value(const char *from, const char *key, const char **next) {
    char pat[64];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(from, pat);
    if (!p) return NULL;
    p += strlen(pat);
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p != ':') return NULL;
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    const char *s, *e;
    if (*p == '"') {
        s = ++p;
        while (*p && !(*p == '"')) { if (*p == '\\' && p[1]) p++; p++; }
        e = p;
        if (next) *next = p + 1;
    } else {
        s = p;
        while (*p && *p != ',' && *p != '}' && *p != ' ' && *p != '\n' && *p != '\r') p++;
        e = p;
        if (next) *next = p;
    }
    char *out = malloc((size_t)(e - s) + 1);
    memcpy(out, s, (size_t)(e - s));
    out[e - s] = 0;
    return out;
}

static int b64_val(int c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static uint8_t *b64_decode(const char *s, size_t *out_len) {
    size_t n = strlen(s);
    uint8_t *out = malloc(n / 4 * 3 + 4);
    size_t o = 0;
    uint32_t acc = 0;
    int bits = 0;
    for (size_t i = 0; i < n; i++) {
        if (s[i] == '=') break;
        int v = b64_val((unsigned char)s[i]);
        if (v < 0) continue;                  // espacios o saltos de línea
        acc = (acc << 6) | (uint32_t)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (uint8_t)((acc >> bits) & 0xFF);
        }
    }
    *out_len = o;
    return out;
}

static int hex_val(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "uso: fn_decrypt boveda.fnvault salida.json [--pass-file f | --key clave.hex] [--save-key clave.hex]\n");
        return 2;
    }
    const char *key_in = NULL, *key_out = NULL, *pass_file = NULL;
    for (int i = 3; i + 1 < argc; i += 2) {
        if (!strcmp(argv[i], "--key")) key_in = argv[i + 1];
        else if (!strcmp(argv[i], "--save-key")) key_out = argv[i + 1];
        else if (!strcmp(argv[i], "--pass-file")) pass_file = argv[i + 1];
    }

    size_t flen;
    char *doc = read_file(argv[1], &flen);
    if (!doc) { fprintf(stderr, "no se puede leer %s\n", argv[1]); return 1; }

    // Campos del encabezado, en el orden en que serde los escribe
    const char *hdr = strstr(doc, "\"header\"");
    const char *pos = hdr ? hdr : doc;
    const char *nx = pos;
    char *magic = json_value(pos, "magic", &nx);
    char *version = json_value(nx, "version", &nx);
    char *vault_id = json_value(nx, "vaultId", &nx);
    char *kdf_alg = json_value(nx, "algorithm", &nx);
    char *mem = json_value(nx, "memoryKib", &nx);
    char *iters = json_value(nx, "iterations", &nx);
    char *par = json_value(nx, "parallelism", &nx);
    char *salt_b64 = json_value(nx, "salt", &nx);
    char *outlen = json_value(nx, "outputLen", &nx);
    char *cip_alg = json_value(nx, "algorithm", &nx);
    char *nonce_b64 = json_value(nx, "nonce", &nx);
    char *created = json_value(nx, "createdAt", &nx);
    char *updated = json_value(nx, "updatedAt", &nx);
    char *payload_b64 = json_value(nx, "payload", &nx);
    if (!magic || !version || !vault_id || !kdf_alg || !mem || !iters || !par || !salt_b64 || !outlen || !cip_alg ||
        !nonce_b64 || !created || !updated || !payload_b64) {
        fprintf(stderr, "bóveda con formato inesperado\n");
        return 3;
    }
    if (strcmp(magic, "passdroid-vault-v1") || strcmp(kdf_alg, "Argon2id") || strcmp(cip_alg, "XChaCha20-Poly1305") ||
        atoi(outlen) != 32) {
        fprintf(stderr, "bóveda no soportada (%s / %s / %s)\n", magic, kdf_alg, cip_alg);
        return 3;
    }

    // Datos asociados: el encabezado en JSON compacto
    size_t aad_cap = 2048 + strlen(vault_id) + strlen(salt_b64) + strlen(nonce_b64) + strlen(created) + strlen(updated);
    char *aad = malloc(aad_cap);
    int aad_len = snprintf(aad, aad_cap,
        "{\"magic\":\"%s\",\"version\":%s,\"vaultId\":\"%s\",\"kdf\":{\"algorithm\":\"%s\",\"memoryKib\":%s,\"iterations\":%s,"
        "\"parallelism\":%s,\"salt\":\"%s\",\"outputLen\":%s},\"cipher\":{\"algorithm\":\"%s\"},\"nonce\":\"%s\","
        "\"createdAt\":\"%s\",\"updatedAt\":\"%s\"}",
        magic, version, vault_id, kdf_alg, mem, iters, par, salt_b64, outlen, cip_alg, nonce_b64, created, updated);

    size_t salt_len, nonce_len, ct_len;
    uint8_t *salt = b64_decode(salt_b64, &salt_len);
    uint8_t *nonce = b64_decode(nonce_b64, &nonce_len);
    uint8_t *ct = b64_decode(payload_b64, &ct_len);
    if (nonce_len != 24 || ct_len < 16) { fprintf(stderr, "nonce o cifrado no validos\n"); return 3; }

    uint8_t key[32];
    long t0 = mono_ms();
    if (key_in) {
        size_t kl;
        char *kh = read_file(key_in, &kl);
        if (!kh || kl < 64) { fprintf(stderr, "clave guardada no valida\n"); return 4; }
        for (int i = 0; i < 32; i++) key[i] = (uint8_t)(hex_val(kh[2 * i]) * 16 + hex_val(kh[2 * i + 1]));
    } else {
        char pw[512] = "";
        const char *env = getenv("FN_PASSWORD");
        if (pass_file) {
            size_t pl;
            char *pf = read_file(pass_file, &pl);
            if (pf) { pf[strcspn(pf, "\r\n")] = 0; snprintf(pw, sizeof(pw), "%s", pf); }
        } else if (env) {
            snprintf(pw, sizeof(pw), "%s", env);
        }
        if (!pw[0]) { fprintf(stderr, "falta la contraseña (FN_PASSWORD o --pass-file)\n"); return 4; }

        uint32_t blocks = (uint32_t)strtoul(mem, NULL, 10);
        if (blocks < 8 || blocks > 262144) { fprintf(stderr, "memoria de Argon2 no soportada: %u KiB\n", blocks); return 3; }
        void *work = malloc((size_t)blocks * 1024);
        if (!work) { fprintf(stderr, "sin memoria para Argon2 (%u KiB)\n", blocks); return 5; }
        crypto_argon2_config cfg = {CRYPTO_ARGON2_ID, blocks, (uint32_t)atoi(iters), (uint32_t)atoi(par)};
        crypto_argon2_inputs in = {(const uint8_t *)pw, salt, (uint32_t)strlen(pw), (uint32_t)salt_len};
        crypto_argon2_extras extras = {0};
        crypto_argon2(key, 32, work, cfg, in, extras);
        free(work);
    }
    long t1 = mono_ms();

    uint8_t *plain = malloc(ct_len);
    int rc = crypto_aead_unlock(plain, ct + ct_len - 16, key, nonce, (const uint8_t *)aad, (size_t)aad_len, ct, ct_len - 16);
    long t2 = mono_ms();
    fprintf(stderr, "clave: %ld ms%s, descifrado: %ld ms, %zu bytes\n", t1 - t0, key_in ? " (guardada)" : " (Argon2id)", t2 - t1,
            ct_len - 16);
    if (rc != 0) { fprintf(stderr, "no se pudo descifrar: contraseña o fichero incorrectos\n"); return 6; }

    if (key_out && !key_in) {
        FILE *kf = fopen(key_out, "w");
        if (kf) {
            for (int i = 0; i < 32; i++) fprintf(kf, "%02x", key[i]);
            fprintf(kf, "\n");
            fclose(kf);
        }
    }
    FILE *o = fopen(argv[2], "wb");
    if (!o) return 1;
    fwrite(plain, 1, ct_len - 16, o);
    fclose(o);
    return 0;
}
