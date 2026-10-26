/** 本地凭据工具：生成随机 Token、计算摘要，并用 scrypt 保存密码哈希。 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** 生成只在创建时返回一次的随机 Bearer Token。 */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 计算输入或 Token 的 SHA-256 十六进制摘要。 */
export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 为新密码生成随机盐和 scrypt 哈希；不保存明文密码。 */
export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

/** 使用定时安全比较校验输入密码。 */
export function verifyPassword(password: string, salt: string, hash: string): boolean {
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
