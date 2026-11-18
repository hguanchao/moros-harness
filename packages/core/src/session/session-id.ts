import { randomBytes as nodeRandomBytes } from "node:crypto";

/**
 * Crockford Base32 字母表，统一小写输出。
 *
 * 刻意不含 i / l / o / u，避免手抄、朗读与字体造成的歧义；字母表大小写不敏感，
 * 固定小写可规避 Windows 文件系统下 `open(id)` 用传入 id、`list()` 用磁盘目录名
 * 而产生两套大小写不一致的 Map key。
 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
/** 时间戳段：10 字符 × 5 bit = 50 bit，容纳 48 bit UTC 毫秒。 */
const STAMP_CHARS = 10;
/** 随机段：10 字节 = 80 bit = 16 字符。 */
const RANDOM_BYTES = 10;
const RANDOM_CHARS = 16;
const MAX_TIMESTAMP = 0xffff_ffff_ffff;

export type RandomBytes = (size: number) => Uint8Array;

const defaultRandomBytes: RandomBytes = (size) => new Uint8Array(nodeRandomBytes(size));

/** 把整数按 5 bit 一组编成定长 Crockford Base32 串。 */
function encode(value: bigint, length: number): string {
	let encoded = "";
	let rest = value;
	for (let index = 0; index < length; index += 1) {
		encoded = `${ALPHABET.charAt(Number(rest & 31n))}${encoded}`;
		rest >>= 5n;
	}
	return encoded;
}

/**
 * 生成会话 ID：26 字符小写 ULID = 10 字符 UTC 毫秒时间戳 + 16 字符 CSPRNG 随机段。
 *
 * 前 10 字符按时间递增，字典序即创建时间序，因此 `sessions/<ph>/<sid>/` 布局无需改动；
 * UTC 毫秒不受时区、夏令时影响，80 位随机让同一毫秒内的撞名概率可忽略（撞名另由
 * `SessionManager.#reserveSessionDirectory` 兜底）。
 *
 * 纯函数，不保留进程级时间戳/计数器状态：时钟与随机源都由调用方注入，便于测试
 * 并做到「随机、时钟可替换，禁止隐藏全局单例」。系统时钟回拨时
 * 字典序可能倒退，但会话列表排序键是 `createdAt`，功能不依赖 ID 的顺序。
 *
 * @param now 生成时刻，默认当前时间。
 * @param random 密码学随机字节源，默认 `node:crypto.randomBytes`。
 */
export function createSessionId(now: Date = new Date(), random: RandomBytes | undefined = undefined): string {
	const timestamp = now.getTime();
	if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > MAX_TIMESTAMP) {
		throw new RangeError("Session ID timestamp must be a non-negative 48-bit millisecond value");
	}
	const source = random ?? defaultRandomBytes;
	const bytes = source(RANDOM_BYTES);
	if (bytes.length !== RANDOM_BYTES) {
		throw new Error(`Random source must return exactly ${RANDOM_BYTES} bytes`);
	}
	let entropy = 0n;
	for (const byte of bytes) entropy = (entropy << 8n) | BigInt(byte);
	return `${encode(BigInt(timestamp), STAMP_CHARS)}${encode(entropy, RANDOM_CHARS)}`;
}
