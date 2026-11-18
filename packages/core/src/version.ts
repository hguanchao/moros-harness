/**
 * 发布版本号（与根 package.json 的 version 同步，测试守护一致性）。
 *
 * 单独成文件而非 import package.json：避免把整个 package.json 打进运行时产物
 * attributes，而版本号只需要一个字符串常量——常量 + 一致性测试是最简单显式的形态。
 */
export const VERSION = "0.1.0";
