import { BROWSER_PARTITION } from "../constants";

/**
 * 通过 @electron/remote 获取主进程 session 对象。
 *
 * 思源在 main 进程调用了 require("@electron/remote/main").initialize()，
 * 渲染进程（nodeIntegration + contextIsolation 关闭）可以直接 require("@electron/remote")
 * 拿到主进程的 session —— webRequest / loadExtension 等 API 只有主进程能调用。
 * 拿不到（非 Electron、remote 被禁用）时返回 null，调用方自行降级。
 */
export function remoteSession(partition: string = BROWSER_PARTITION): any | null {
    try {
        const req = (window as any).require;
        const remote = req?.("@electron/remote");
        if (!remote?.session?.fromPartition) return null;
        return remote.session.fromPartition(partition);
    } catch {
        return null;
    }
}
