// yxpil · 插件进程侧 SDK 的类型声明（宿主物化，编辑器与 tsc 都吃这份）
// 只描述能力形状，不含实现；实现与错误语义见 index.cjs 顶部注释。

export interface BitEnv {
  /** 本插件 id（= 插件目录名） */
  id: string;
  /** 托管服务名；server / 工具进程里为空 */
  service: string;
  /** 宿主插件 API 基址，形如 http://127.0.0.1:<端口> */
  api: string;
  /** 宿主分给本进程的口（未声明端口时为 0） */
  port: number;
  /** 插件目录绝对路径 */
  dir: string;
  /** 本次会话令牌（不落盘、停用即收回） */
  token: string;
  /** 生效权限位（清单申报 ∧ 用户未单独关闭） */
  perms: string[];
}

export class BitError extends Error {
  /** 403 = 清单没申报这个能力；400 = 参数不对；0 = 本地就没发出去（缺凭据/超时） */
  status: number;
  verb: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
  timed_out: boolean;
  timeout_ms: number;
  duration_ms: number;
}

export interface RuntimeInfo {
  id: string;
  name: string;
  path: string;
  version: string;
  lang: string;
  mode: string;
  enabled: boolean;
}

export interface CapOptions {
  timeoutMs?: number;
}

/** 能力调用：verb 与所需权限位见 bit.caps()，未申报的直接抛 BitError(403) */
export function cap(verb: string, payload?: Record<string, unknown>, opts?: CapOptions): Promise<any>;

export interface Bit {
  VERSION: string;
  BitError: typeof BitError;
  env: BitEnv;
  cap: typeof cap;
  /** 同步判断：某条权限位当前是否生效（读宿主下发的环境） */
  can(perm: string): boolean;
  /** 让本插件的 AI 回答一句话；会话强制落在 plugin:<id> 命名空间（需 chat 权限） */
  chat(message: string, opts?: { session_id?: string; images?: string[]; timeoutMs?: number }): Promise<{ reply: string; session_id: string }>;
  history(sessionId?: string): Promise<any>;
  info(): Promise<{ plugin_id: string; plugin_name: string; version: string; permissions: string[]; has_settings: boolean }>;
  caps(): Promise<string[]>;
  settings: {
    all(): Promise<Record<string, unknown>>;
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<any>;
    getJSON<T = any>(key: string, fallback?: T): Promise<T | null>;
    setJSON(key: string, value: unknown): Promise<any>;
  };
  data: {
    list(): Promise<any>;
    read(path: string): Promise<string>;
    write(path: string, text: string): Promise<any>;
    remove(path: string): Promise<any>;
    readJSON<T = any>(path: string, fallback?: T): Promise<T | null>;
    writeJSON(path: string, value: unknown): Promise<any>;
  };
  fs: {
    list(path?: string): Promise<any>;
    stat(path: string): Promise<any>;
    exists(path: string): Promise<boolean>;
    read(path: string, opts?: Record<string, unknown>): Promise<string>;
    readJSON<T = any>(path: string, opts?: Record<string, unknown>): Promise<T | null>;
    write(path: string, text: string, opts?: Record<string, unknown>): Promise<any>;
    writeJSON(path: string, value: unknown, opts?: Record<string, unknown>): Promise<any>;
    append(path: string, text: string): Promise<any>;
    remove(path: string, recursive?: boolean): Promise<any>;
    mkdir(path: string): Promise<any>;
    move(from: string, to: string): Promise<any>;
  };
  sessions: {
    list(): Promise<any[]>;
    read(sessionId?: string): Promise<any>;
    append(role: string, content: string, sessionId?: string): Promise<any>;
    wake(sessionId: string, text: string): Promise<any>;
  };
  services: {
    list(): Promise<any>;
    save(entry: Record<string, unknown>): Promise<any>;
    start(name: string): Promise<any>;
    stop(name: string): Promise<any>;
    remove(name: string): Promise<any>;
  };
  server: { status(): Promise<any>; start(): Promise<any>; stop(): Promise<any> };
  /** 清单 connections[] 声明的外部 MCP 连接（需 net 权限）：只看/管本插件自己那几条 */
  net: {
    connections(): Promise<Array<{
      id: string;
      name: string;
      label: string;
      url_template: string;
      url: string;
      header_names: string[];
      needs_settings: string[];
      auto_connect: boolean;
      missing_settings: string[];
      granted: boolean;
      connected: boolean;
      server_name: string;
      tools: number;
      connected_at: string;
    }>>;
    connect(name: string): Promise<any>;
    disconnect(name: string): Promise<any>;
  };
  exec: {
    run(command: string, opts?: Record<string, unknown>): Promise<ExecResult>;
    program(program: string, args?: string[], opts?: Record<string, unknown>): Promise<ExecResult>;
    node(args: string[], opts?: Record<string, unknown>): Promise<ExecResult>;
    python(args: string[], opts?: Record<string, unknown>): Promise<ExecResult>;
    powershell(args: string[], opts?: Record<string, unknown>): Promise<ExecResult>;
    nodeEval(code: string, opts?: Record<string, unknown>): Promise<ExecResult>;
  };
  runtime: { list(): Promise<RuntimeInfo[]>; has(id: string): Promise<boolean> };
  /** 本插件登记且当前生效的文件类型（需 files 权限） */
  files: {
    kinds(): Promise<Array<{ id: string; label: string; exts: string[]; paths: string[]; tool: string | null }>>;
  };
  notify(title: string, body?: string): Promise<any>;
  sleep(ms: number): Promise<void>;
  log(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

declare const bit: Bit;
export default bit;
