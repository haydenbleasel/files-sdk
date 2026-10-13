/* oxlint-disable no-bitwise -- MD5 (RFC 1321) is defined in 32-bit word operations: boolean mixing functions, left rotations, and addition modulo 2^32. */

/**
 * MD5 (RFC 1321) of `bytes`, as 32 lowercase hex characters.
 *
 * Synchronous and pure JS, so it runs where `node:crypto` doesn't (browsers,
 * edge runtimes) and where a caller can't await: Web Crypto has no MD5, and
 * its `digest()` is async. The memory adapter fingerprints seed bodies inside
 * its synchronous constructor, which is why this exists.
 *
 * A content fingerprint, not a security primitive: MD5 collisions can be
 * constructed on purpose. It plays the role S3 gives it in a single-part
 * upload's ETag.
 */

// floor(|sin(i + 1)| * 2^32) for each of the 64 steps. Written out rather than
// computed so no engine's `Math.sin` rounding can change a digest.
const SINES = Uint32Array.of(
  0xd7_6a_a4_78,
  0xe8_c7_b7_56,
  0x24_20_70_db,
  0xc1_bd_ce_ee,
  0xf5_7c_0f_af,
  0x47_87_c6_2a,
  0xa8_30_46_13,
  0xfd_46_95_01,
  0x69_80_98_d8,
  0x8b_44_f7_af,
  0xff_ff_5b_b1,
  0x89_5c_d7_be,
  0x6b_90_11_22,
  0xfd_98_71_93,
  0xa6_79_43_8e,
  0x49_b4_08_21,
  0xf6_1e_25_62,
  0xc0_40_b3_40,
  0x26_5e_5a_51,
  0xe9_b6_c7_aa,
  0xd6_2f_10_5d,
  0x02_44_14_53,
  0xd8_a1_e6_81,
  0xe7_d3_fb_c8,
  0x21_e1_cd_e6,
  0xc3_37_07_d6,
  0xf4_d5_0d_87,
  0x45_5a_14_ed,
  0xa9_e3_e9_05,
  0xfc_ef_a3_f8,
  0x67_6f_02_d9,
  0x8d_2a_4c_8a,
  0xff_fa_39_42,
  0x87_71_f6_81,
  0x6d_9d_61_22,
  0xfd_e5_38_0c,
  0xa4_be_ea_44,
  0x4b_de_cf_a9,
  0xf6_bb_4b_60,
  0xbe_bf_bc_70,
  0x28_9b_7e_c6,
  0xea_a1_27_fa,
  0xd4_ef_30_85,
  0x04_88_1d_05,
  0xd9_d4_d0_39,
  0xe6_db_99_e5,
  0x1f_a2_7c_f8,
  0xc4_ac_56_65,
  0xf4_29_22_44,
  0x43_2a_ff_97,
  0xab_94_23_a7,
  0xfc_93_a0_39,
  0x65_5b_59_c3,
  0x8f_0c_cc_92,
  0xff_ef_f4_7d,
  0x85_84_5d_d1,
  0x6f_a8_7e_4f,
  0xfe_2c_e6_e0,
  0xa3_01_43_14,
  0x4e_08_11_a1,
  0xf7_53_7e_82,
  0xbd_3a_f2_35,
  0x2a_d7_d2_bb,
  0xeb_86_d3_91
);

// Left-rotation amounts: four per round, cycled across its 16 steps.
const SHIFTS = Uint8Array.of(
  7,
  12,
  17,
  22,
  5,
  9,
  14,
  20,
  4,
  11,
  16,
  23,
  6,
  10,
  15,
  21
);

const BLOCK_BYTES = 64;
// The last block keeps 8 bytes for the message length, so a tail of 56 or
// more leftover bytes (plus the 0x80 terminator) spills into a second block.
const LENGTH_OFFSET = 56;

// Addition modulo 2^32, as MD5 specifies, returned as a signed 32-bit integer.
// oxlint-disable-next-line unicorn/prefer-math-trunc -- `| 0` wraps the sum to 32 bits; Math.trunc would leave it unbounded.
const add32 = (x: number, y: number): number => (x + y) | 0;

interface Md5State {
  a: number;
  b: number;
  c: number;
  d: number;
}

/** Fold the 64-byte block at `offset` of `view` into `state`. */
const compress = (state: Md5State, view: DataView, offset: number): void => {
  let { a, b, c, d } = state;
  for (let step = 0; step < 64; step += 1) {
    const round = step >>> 4;
    // Each round has its own mixing function and order of message words.
    let mixed: number;
    let word: number;
    if (round === 0) {
      mixed = (b & c) | (~b & d);
      word = step;
    } else if (round === 1) {
      mixed = (d & b) | (~d & c);
      word = (5 * step + 1) & 15;
    } else if (round === 2) {
      mixed = b ^ c ^ d;
      word = (3 * step + 5) & 15;
    } else {
      mixed = c ^ (b | ~d);
      word = (7 * step) & 15;
    }
    // SAFETY: `step` is 0..63 and SINES has 64 entries.
    const sine = SINES[step] as number;
    // SAFETY: `round` is 0..3, so the index is 0..15 and SHIFTS has 16 entries.
    const shift = SHIFTS[(round << 2) | (step & 3)] as number;
    // Bitwise operators wrap their operands to 32 bits, so this sum (exact well
    // past 2^32) only has to stay below 2^53 to rotate correctly.
    const sum = a + mixed + sine + view.getUint32(offset + word * 4, true);
    a = d;
    d = c;
    c = b;
    b = add32(b, (sum << shift) | (sum >>> (32 - shift)));
  }
  state.a = add32(state.a, a);
  state.b = add32(state.b, b);
  state.c = add32(state.c, c);
  state.d = add32(state.d, d);
};

export const md5Hex = (bytes: Uint8Array): string => {
  const state: Md5State = {
    a: 0x67_45_23_01,
    b: 0xef_cd_ab_89,
    c: 0x98_ba_dc_fe,
    d: 0x10_32_54_76,
  };
  // Whole blocks are read in place, so hashing never copies the body.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const whole = bytes.byteLength - (bytes.byteLength % BLOCK_BYTES);
  for (let offset = 0; offset < whole; offset += BLOCK_BYTES) {
    compress(state, view, offset);
  }

  // Padding: the leftover bytes, a 0x80 terminator, zero fill, then the
  // message length in bits as a little-endian 64-bit integer.
  const leftover = bytes.byteLength - whole;
  const tail = new Uint8Array(
    leftover < LENGTH_OFFSET ? BLOCK_BYTES : BLOCK_BYTES * 2
  );
  tail.set(bytes.subarray(whole));
  tail[leftover] = 0x80;
  const tailView = new DataView(tail.buffer);
  const bits = bytes.byteLength * 8;
  // `setUint32` stores its argument modulo 2^32, which is the low word.
  tailView.setUint32(tail.byteLength - 8, bits, true);
  tailView.setUint32(tail.byteLength - 4, Math.floor(bits / 2 ** 32), true);
  for (let offset = 0; offset < tail.byteLength; offset += BLOCK_BYTES) {
    compress(state, tailView, offset);
  }

  // The digest is the four state words, each little-endian.
  const digest = new DataView(new ArrayBuffer(16));
  digest.setUint32(0, state.a, true);
  digest.setUint32(4, state.b, true);
  digest.setUint32(8, state.c, true);
  digest.setUint32(12, state.d, true);
  let hex = "";
  for (let at = 0; at < digest.byteLength; at += 1) {
    hex += digest.getUint8(at).toString(16).padStart(2, "0");
  }
  return hex;
};
