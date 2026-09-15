// 格式器所有权声明（C11）。
//
// 被生成的代码文件（vendored guards/scripts、commitlint 配置、hook 体）是**逐字节**
// 比对与替换的：一旦消费者自己的 Prettier 重排了它们，doctor 会报 drift、update 会
// 报 conflict，而运维人员无法判断这是「本地真实改动」还是「格式器顺手重排」。
//
// 因此所有权必须显式声明：这些路径由生成器拥有，消费者格式器不得触碰。本模块把该
// 声明写进 `.prettierignore` 的托管块（消费者自己的行原样保留），与 lefthook.yml /
// pnpm-workspace.yaml 同属「合并托管」语义 —— 生成器只增删自己那几行。
//
// 只有真正会被 Prettier 重排的托管路径才需要声明（package.json 不在其中：它是
// 语义合并的，Prettier 的 JSON 排版与生成器一致，不会来回打架）。
import { CODES, CliError } from "./errors.mjs";

export const PRETTIER_IGNORE_FILE = ".prettierignore";

const BEGIN = "# bench-quality-cli managed — 以下路径由生成器拥有（init/update 维护），";
const BEGIN2 = "# 消费者格式器不得重排；否则 doctor 会把格式差异报成本地改动。";
const END = "# /bench-quality-cli managed";

/** 需要豁免格式化的托管路径形态（按最具体的目录前缀给）。 */
export const MANAGED_FORMATTER_EXCLUSIONS = [
  "scripts/quality/",
  "commitlint.config.js",
  "lefthook.yml",
  "pnpm-workspace.yaml",
  ".husky/",
];

function matchesManaged(pattern, managedPaths) {
  return managedPaths.some((relPath) =>
    pattern.endsWith("/") ? relPath.startsWith(pattern) : relPath === pattern,
  );
}

function assertLineSafe(lines) {
  for (const line of lines) {
    if (line.includes("\n") || line.includes("\r")) {
      throw new CliError(CODES.INVALID_MANIFEST, `${PRETTIER_IGNORE_FILE} entry ${JSON.stringify(line)} contains a line break`);
    }
  }
}

/** 摘掉旧的托管块（标记之间）以及记录过、但本次不再需要的托管行。 */
function stripManagedBlock(lines, previousLines) {
  const previous = new Set(previousLines);
  const kept = [];
  let inside = false;
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, "").trim();
    if (trimmed === BEGIN) {
      inside = true;
      continue;
    }
    if (trimmed === BEGIN2) continue;
    if (trimmed === END) {
      inside = false;
      continue;
    }
    if (inside) continue;
    if (previous.has(trimmed)) continue;
    kept.push(line);
  }
  return kept;
}

function trimTrailingBlank(lines) {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

/**
 * 合并 `.prettierignore`：消费者自己的行（含注释与 CRLF 行尾）保持原样，只维护
 * 托管块。返回内容与上次相同则 `changed: false`（幂等）。
 */
export function planPrettierIgnore({ raw, managedPaths = [], previousLines = [] }) {
  const wanted = MANAGED_FORMATTER_EXCLUSIONS.filter((pattern) => matchesManaged(pattern, managedPaths));
  assertLineSafe([...wanted, ...previousLines]);

  const lines = raw === null ? [] : raw.split("\n");
  const kept = trimTrailingBlank(stripManagedBlock(lines, previousLines));
  const block = wanted.length > 0 ? [BEGIN, BEGIN2, ...wanted, END] : [];
  const body = [...kept];
  if (block.length > 0 && body.length > 0) body.push("");
  body.push(...block);

  const content = `${body.join("\n").replace(/\n+$/, "")}\n`;
  return {
    content,
    changed: content !== raw,
    managedLines: wanted,
    existed: raw !== null,
  };
}
