use rand_core::{OsRng, RngCore};

use crate::models::GeneratePasswordOptions;

pub fn generate_password(options: GeneratePasswordOptions) -> Result<String, String> {
    let length = options.length.clamp(8, 256);
    let mut groups: Vec<&[u8]> = Vec::new();
    if options.uppercase {
        groups.push(b"ABCDEFGHJKLMNPQRSTUVWXYZ");
    }
    if options.lowercase {
        groups.push(b"abcdefghijkmnopqrstuvwxyz");
    }
    if options.numbers {
        groups.push(b"23456789");
    }
    if options.symbols {
        groups.push(b"!@#$%^&*()-_=+[]{};:,.?");
    }
    if groups.is_empty() {
        return Err("password_generator_empty_charset".to_string());
    }

    let mut chars = Vec::new();
    for group in &groups {
        chars.push(random_pick(group));
    }

    let all = groups.concat();
    while chars.len() < length {
        chars.push(random_pick(&all));
    }
    shuffle(&mut chars);
    String::from_utf8(chars).map_err(|_| "password_generator_failed".to_string())
}

/// Uniformly pick one byte from `group` using rejection sampling to avoid the
/// modulo bias of `u32 % len`.
fn random_pick(group: &[u8]) -> u8 {
    group[random_index(group.len())]
}

/// Uniform index in `0..len` via rejection sampling on a fresh u32.
fn random_index(len: usize) -> usize {
    debug_assert!(len > 0);
    let len = len as u32;
    let limit = u32::MAX - (u32::MAX % len);
    loop {
        let mut bytes = [0u8; 4];
        OsRng.fill_bytes(&mut bytes);
        let value = u32::from_le_bytes(bytes);
        if value < limit {
            return (value % len) as usize;
        }
    }
}

fn shuffle(chars: &mut [u8]) {
    for idx in (1..chars.len()).rev() {
        let swap_idx = random_index(idx + 1);
        chars.swap(idx, swap_idx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_password_respects_length() {
        let password = generate_password(GeneratePasswordOptions {
            length: 24,
            uppercase: true,
            lowercase: true,
            numbers: true,
            symbols: true,
        })
        .unwrap();
        assert_eq!(password.len(), 24);
    }

    #[test]
    fn generated_password_rejects_empty_charset() {
        let result = generate_password(GeneratePasswordOptions {
            length: 16,
            uppercase: false,
            lowercase: false,
            numbers: false,
            symbols: false,
        });
        assert_eq!(result, Err("password_generator_empty_charset".to_string()));
    }
}
