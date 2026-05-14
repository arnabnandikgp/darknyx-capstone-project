//! Helper CLI used by the TS parity test to emit a Nullifier as hex.
//!
//! Formula (matches `circuits/valid_spend/circuit.circom`):
//!   nullifier = Poseidon2( spending_key_fr, note_commitment_fr )
//!
//! Usage:
//!   nullifier <spending_key_dec> <note_commitment_hex64>
//!
//! Outputs: 64-char hex string of the 32-byte BE nullifier.

use ark_bn254::Fr;
use ark_ff::PrimeField;
use darkpool_crypto::nullifier::nullifier;

fn dec_to_fr(s: &str) -> Fr {
    let mut digits: Vec<u8> = s.bytes().map(|b| b - b'0').collect();
    let mut be = Vec::new();
    while !digits.is_empty() {
        let mut rem: u32 = 0;
        let mut new_digits = Vec::with_capacity(digits.len());
        for d in &digits {
            let cur = rem * 10 + *d as u32;
            let q = cur / 256;
            rem = cur % 256;
            if !(new_digits.is_empty() && q == 0) {
                new_digits.push(q as u8);
            }
        }
        be.insert(0, rem as u8);
        digits = new_digits;
    }
    if be.is_empty() {
        be.push(0);
    }
    Fr::from_be_bytes_mod_order(&be)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: nullifier <spending_key_dec> <note_commitment_hex64>");
        std::process::exit(2);
    }

    let sk = dec_to_fr(&args[1]);
    let c_bytes = hex::decode(&args[2]).expect("invalid hex for note_commitment");
    assert_eq!(c_bytes.len(), 32, "note_commitment must be 32 bytes");
    let mut c = [0u8; 32];
    c.copy_from_slice(&c_bytes);

    let n = nullifier(&sk, &c).expect("nullifier compute failed");
    println!("{}", hex::encode(n));
}
