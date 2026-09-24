// Encrypts account-settings secrets at rest (AES-256-GCM). The key comes from SETTINGS_ENCRYPTION_KEY or from a
// key file generated next to the database; with neither, the box reports itself unavailable and the settings
// service refuses to store secrets instead of writing them in clear.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

export type SecretBoxMode = "env-key" | "key-file" | "unavailable";
export interface SecretBox { mode: SecretBoxMode; note: string; encrypt(plain: string): string; decrypt(cipher: string): string }
export class SecretBoxError extends Error { constructor(message: string) { super(message); this.name = "SecretBoxError"; } }

const HEX_KEY = /^[0-9a-fA-F]{64}$/, VERSION = "v1", IV_BYTES = 12, TAG_BYTES = 16;
const UNAVAILABLE = "加密密钥不可用：请设置 SETTINGS_ENCRYPTION_KEY，或确保数据目录可写以便生成密钥文件；在此之前无法保存或读取密钥类设置。";

export async function createSecretBox(options: { env?: NodeJS.ProcessEnv; keyFilePath: string }): Promise<SecretBox> {
  const fromEnv = (options.env ?? process.env).SETTINGS_ENCRYPTION_KEY?.trim();
  if (fromEnv) {
    const key = HEX_KEY.test(fromEnv) ? Buffer.from(fromEnv, "hex") : createHash("sha256").update(fromEnv, "utf8").digest();
    return box(key, "env-key", "密钥来自环境变量 SETTINGS_ENCRYPTION_KEY；更换该值后，已保存的密钥类设置需要重新填写。");
  }
  try {
    const key = await loadOrCreateKeyFile(options.keyFilePath);
    return box(key, "key-file", `密钥保存在数据目录的 ${basename(options.keyFilePath)} 文件中，请随数据库一起备份；设置 SETTINGS_ENCRYPTION_KEY 可改用环境变量密钥。`);
  } catch (error) {
    // Only the error code is surfaced: file-system messages may carry paths, never useful to the UI.
    const code = error instanceof SecretBoxError ? error.message : (error as NodeJS.ErrnoException).code ?? "unknown";
    return { mode: "unavailable", note: `${UNAVAILABLE}（密钥文件不可用：${code}）`, encrypt() { throw new SecretBoxError(UNAVAILABLE); }, decrypt() { throw new SecretBoxError(UNAVAILABLE); } };
  }
}

async function loadOrCreateKeyFile(path: string): Promise<Buffer> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await readKeyFile(path);
    if (existing) return existing;
    const hex = randomBytes(32).toString("hex");
    await mkdir(dirname(path), { recursive: true });
    try { await writeFile(path, `${hex}\n`, { mode: 0o600, flag: "wx" }); return Buffer.from(hex, "hex"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } // another process won the race: re-read
  }
  throw new SecretBoxError("密钥文件无法创建");
}

async function readKeyFile(path: string): Promise<Buffer | null> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const hex = text.trim();
  if (!HEX_KEY.test(hex)) throw new SecretBoxError("密钥文件内容不是 64 位十六进制");
  return Buffer.from(hex, "hex");
}

// Wire format: v1:<iv base64>:<auth tag base64>:<ciphertext base64>; GCM authenticates iv/tag/body together.
function box(key: Buffer, mode: SecretBoxMode, note: string): SecretBox {
  return {
    mode, note,
    encrypt(plain) {
      const iv = randomBytes(IV_BYTES), cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
    },
    decrypt(text) {
      const parts = typeof text === "string" ? text.split(":") : [];
      if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretBoxError("密文格式无法识别");
      const [iv, tag, body] = parts.slice(1).map(part => Buffer.from(part!, "base64"));
      if (iv!.length !== IV_BYTES || tag!.length !== TAG_BYTES) throw new SecretBoxError("密文格式无法识别");
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv!);
        decipher.setAuthTag(tag!);
        return Buffer.concat([decipher.update(body!), decipher.final()]).toString("utf8");
      } catch { throw new SecretBoxError("密文校验失败：加密密钥已更换或数据被篡改"); }
    },
  };
}
