/**
 * Minimal ambient typing for `snarkjs` — the upstream package ships no types.
 *
 * We only declare the surface our code actually consumes (Groth16 fullProve)
 * so we don't accidentally type-check against a fictional API.
 */
declare module "snarkjs" {
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }

  export interface Groth16ProveResult {
    proof: Groth16Proof;
    publicSignals: string[];
  }

  export const groth16: {
    /**
     * Generate a witness + Groth16 proof in one shot. URLs/paths can be
     * absolute, relative to `location.origin` (browser), or filesystem paths
     * (Node).
     */
    fullProve(
      input: Record<string, string | string[]>,
      wasmFile: string | Uint8Array,
      zkeyFile: string | Uint8Array,
    ): Promise<Groth16ProveResult>;

    verify(
      vKey: unknown,
      publicSignals: string[],
      proof: Groth16Proof,
    ): Promise<boolean>;
  };
}
