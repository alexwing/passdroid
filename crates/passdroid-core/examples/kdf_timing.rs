//! Native Argon2id reference timing for the Phase 0 WASM comparison.
//!   cargo run --release --example kdf_timing
//! Same salt as the browser benchmark (bytes 0..16); 1 warm-up + 5 runs each.

use std::time::Instant;

use passdroid_core::{derive_key, encode_b64, KdfParams};

fn main() {
    let salt: Vec<u8> = (0u8..16).collect();
    for (label, memory_kib) in [("64 MiB", 65536u32), ("32 MiB", 32768u32)] {
        let params = KdfParams {
            algorithm: "Argon2id".to_string(),
            memory_kib,
            iterations: 3,
            parallelism: 1,
            salt: encode_b64(&salt),
            output_len: 32,
        };
        let mut runs_ms = Vec::new();
        let mut key_hex = String::new();
        for i in 0..6 {
            let t0 = Instant::now();
            let key = derive_key("phase0-bench-password", &params).expect("derive_key");
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            key_hex = key.iter().map(|b| format!("{b:02x}")).collect();
            if i > 0 {
                runs_ms.push(ms); // run 0 is the warm-up
            }
        }
        runs_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "native Argon2id {label} t=3 p=1: median {:.0} ms, min {:.0} ms, max {:.0} ms, key {key_hex}",
            runs_ms[runs_ms.len() / 2],
            runs_ms[0],
            runs_ms[runs_ms.len() - 1]
        );
    }
}
