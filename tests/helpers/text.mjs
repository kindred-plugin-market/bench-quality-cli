/**
 * 跨平台文本断言助手（C10）。
 *
 * 背景：Windows runner 上 git 默认 `core.autocrlf=true`，仓库里的文本文件
 * （pnpm-workspace.yaml、tests/fixtures/*.yaml）落盘是 CRLF，路径分隔符也是
 * `\`。此前三个用例把「LF + POSIX 路径」当成协议，于是同一份被验证过的代码在
 * Windows 上是红的（quality run 34922413857：4 failed / 3 skipped）。
 *
 * 约定：**比较语义，不比较字节形态**。
 *   - 文本：先 normalizeEol 再断言行内容 / 行级正则；
 *   - 路径：先 toPosixPath 再断言末段，或用 path.normalize、pathToFileURL。
 * 需要字节级比较的地方（manifest 哈希）不经过这里。
 */

/** CRLF / 孤立 CR 一律归一为 LF。 */
export const normalizeEol = (text) => text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")

/** Windows 反斜杠路径转 POSIX 形态，便于断言末段（`bin/index.mjs`）。 */
export const toPosixPath = (value) => value.replaceAll("\\", "/")
