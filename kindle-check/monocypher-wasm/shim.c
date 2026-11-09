// Freestanding wasm32 shim over Monocypher 4.0.2 for the Passdroid vault format.
// Exports: pd_alloc / pd_reset (bump allocator over memory.grow), pd_argon2id, pd_aead_open.
#include <stddef.h>
#include <stdint.h>
#include "monocypher.h"

#define EXPORT(name) __attribute__((export_name(name)))
#define PAGE 65536u

extern unsigned char __heap_base;
static uintptr_t heap_top;

// libc symbols the compiler may emit even with -nostdlib (compiled with -fno-builtin, so no self-recursion).
void *memcpy(void *d, const void *s, size_t n) {
    unsigned char *dp = d; const unsigned char *sp = s;
    while (n--) *dp++ = *sp++;
    return d;
}
void *memmove(void *d, const void *s, size_t n) {
    unsigned char *dp = d; const unsigned char *sp = s;
    if (dp < sp) { while (n--) *dp++ = *sp++; }
    else { dp += n; sp += n; while (n--) *--dp = *--sp; }
    return d;
}
void *memset(void *d, int c, size_t n) {
    unsigned char *dp = d;
    while (n--) *dp++ = (unsigned char)c;
    return d;
}

// Bump allocator: 16-byte aligned, grows memory on demand, returns 0 on failure.
static void *bump(size_t n) {
    if (!heap_top) heap_top = (uintptr_t)&__heap_base;
    uintptr_t start = (heap_top + 15u) & ~(uintptr_t)15u;
    uint64_t end = (uint64_t)start + n;
    if (end > 0xFFFFFFFFull) return 0;
    uint64_t have = (uint64_t)__builtin_wasm_memory_size(0) * PAGE;
    if (end > have) {
        size_t pages = (size_t)((end - have + PAGE - 1) / PAGE);
        if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return 0;
    }
    heap_top = (uintptr_t)end;
    return (void *)start;
}

EXPORT("pd_alloc") void *pd_alloc(size_t n) { return bump(n); }
EXPORT("pd_reset") void pd_reset(void) { heap_top = (uintptr_t)&__heap_base; }

// Argon2id v1.3, 32-byte output. Returns 0 ok, -1 invalid params, -2 out of memory.
EXPORT("pd_argon2id")
int pd_argon2id(const uint8_t *pass, uint32_t pass_len, const uint8_t *salt, uint32_t salt_len,
                uint32_t m_kib, uint32_t t, uint32_t p, uint8_t *out) {
    if (m_kib < 8u * p || t < 1 || p < 1 || m_kib > (0xFFFFFFFFu >> 10)) return -1;
    uintptr_t mark = heap_top;
    void *work = bump((size_t)m_kib * 1024u);
    if (!work) return -2;
    crypto_argon2_config cfg = { CRYPTO_ARGON2_ID, m_kib, t, p };
    crypto_argon2_inputs in = { pass, salt, pass_len, salt_len };
    crypto_argon2(out, 32, work, cfg, in, crypto_argon2_no_extras);
    crypto_wipe(work, (size_t)m_kib * 1024u);
    heap_top = mark;
    return 0;
}

// XChaCha20-Poly1305 open. ct = ciphertext || 16-byte tag (ct_len includes the tag); out gets ct_len-16 bytes.
// Returns 0 ok, nonzero on authentication failure or short input.
EXPORT("pd_aead_open")
int pd_aead_open(const uint8_t *key, const uint8_t *nonce, const uint8_t *ad, uint32_t ad_len,
                 const uint8_t *ct, uint32_t ct_len, uint8_t *out) {
    if (ct_len < 16) return -1;
    return crypto_aead_unlock(out, ct + ct_len - 16, key, nonce, ad, ad_len, ct, ct_len - 16);
}
