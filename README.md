# Nyx Darkpool

A **dark pool on Solana** for SPL tokens. Order intent stays inside a
MagicBlock Private Ephemeral Rollup (PER), settlement is atomic on L1 with a
TEE-signed payload, and balances are encrypted UTXO notes (Poseidon
commitments in an incremental Merkle tree). Withdrawals require a
Groth16 ZK proof.

> **Status:** functional on Solana **devnet**. Live ER end-to-end flow
> is green. **Not audited. Not for mainnet use.**

---

## At a glance

| Property                        | How                                                                  |
|---------------------------------|----------------------------------------------------------------------|
| Hidden order intent             | `submit_order` runs inside the MagicBlock ER, never on L1            |
| Hidden balances                 | UTXO notes (Poseidon commitments) in a depth-20 Merkle tree          |
| Atomic settlement               | TEE Ed25519-signed `tee_forced_settle` enforces conservation on L1   |
| Trustless withdrawal            | Groth16 `VALID_SPEND` proof — no operator can move user funds        |
| Front-running protection        | Uniform clearing price + Pyth circuit breaker per batch              |

---

## Deployed programs (Solana devnet)

| Program           | Address                                          |
|-------------------|--------------------------------------------------|
| `vault`           | `ELt4FH2gH8RaZkYbvbbDjGkX8dPhGFdWnspM4w1fdjoY`   |
| `matching_engine` | `DvYcaiBuaHgJFVjVd57JLM7ZMavzXvBezJwsvA46FJbH`   |

MagicBlock infra (used by the SDK):

| Thing                            | Address                                          |
|----------------------------------|--------------------------------------------------|
| Delegation program               | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`  |
| Magic program                    | `Magic11111111111111111111111111111111111111`  |
| Magic context                    | `MagicContext1111111111111111111111111111111`  |
| PER RPC (devnet)                  | `https://devnet.magicblock.app`                |

Verify on-chain:

```sh
solana program show ELt4FH2gH8RaZkYbvbbDjGkX8dPhGFdWnspM4w1fdjoY
solana program show DvYcaiBuaHgJFVjVd57JLM7ZMavzXvBezJwsvA46FJbH
```

---

## Quickstart

```sh
# 1. Install everything
npm install

# 2. Build the ZK circuits + Rust verifier-key consts
bash scripts/build-circuits.sh

# 3. Build the on-chain programs
cargo build-sbf --manifest-path programs/vault/Cargo.toml
cargo build-sbf --manifest-path programs/matching_engine/Cargo.toml

# 4. Run the full test gate (86 Rust + 76 SDK tests)
cargo test --workspace
( cd packages/sdk && ../../node_modules/.bin/vitest run )
```

To run the live devnet ER trade flow, see
[`scripts/dev-commands.md`](scripts/dev-commands.md) §10 / §11.

---

## Repo layout (one-liner per top-level dir)

| Path             | What's there                                                                |
|------------------|------------------------------------------------------------------------------|
| `programs/`      | On-chain Anchor programs — `vault` and `matching_engine`                    |
| `crates/`        | `darkpool-crypto` — host-side Poseidon / key derivation / note crypto       |
| `circuits/`      | Circom 2 ZK circuits — `valid_wallet_create`, `valid_spend`                 |
| `packages/sdk/`  | `@nyx/sdk` — TypeScript client (ix builders, prover, settlement)            |
| `scripts/`       | Build / deploy / setup shell scripts + master dev cheat-sheet               |
| `docs/`          | Deep-dive design docs                                                        |
| `.devnet/`       | Generated keypairs + e2e config (gitignored)                                 |

---

## Documentation map

| Document                                                       | Read it for…                                                |
|----------------------------------------------------------------|-------------------------------------------------------------|
| **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**             | Deep dive — every component, PDA, flow, threat model        |
| **[`DeepWiki`](https://deepwiki.com/skysail-labs/darknyx)**    | Indexed, code-linked walkthrough of the repo                |
| **[`scripts/dev-commands.md`](scripts/dev-commands.md)**       | Master command cheat-sheet — build, test, deploy, troubleshoot |
| `order_privacy_fix.md`                                         | Design note — why `submit_order` moved into the ER          |
| `partial_fill_and_fee_notes.md`                                | Design note — partial-fill collateral rotation + fee notes   |
| `change_note_implementation.md`                                | Design note — change-note schema for partial fills          |
| `darkpool_protocol_spec_v3_changed.md`                         | Original protocol spec (historical reference)                |

The `*.md` design notes at the repo root are historical and informative;
the **authoritative** description of the live system is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), the indexed
[DeepWiki](https://deepwiki.com/skysail-labs/darknyx), and in the source code under
`programs/` and `packages/sdk/src/`.

---

## License

Apache-2.0.
