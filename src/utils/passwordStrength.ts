// Rough strength estimate used only for UI hints (length + character variety).
// It is not a security guarantee and never leaves the device.
export type StrengthLevel = 0 | 1 | 2 | 3 | 4;

const CLASSES = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/];

// 0 = empty, 1 = weak, 2 = fair, 3-4 = strong.
export function passwordStrength(password: string): StrengthLevel {
  if (!password) return 0;
  const chars = Array.from(password);
  const variety = CLASSES.filter((re) => re.test(password)).length;
  // Short or mostly repeated characters are weak whatever they contain.
  if (chars.length < 8 || new Set(chars).size <= 3) return 1;
  if (chars.length >= 16 && variety >= 3) return 4;
  if (chars.length >= 12 && variety >= 3) return 3;
  // A long passphrase with many distinct characters is strong even in one class.
  if (chars.length >= 20 && new Set(chars).size >= 10) return 3;
  if (variety >= 2) return 2;
  return 1;
}
