/**
 * Nuxt API 的平台适配入口。
 *
 * Nuxt 将 /api/** 请求交给本模块。入口把平台提供的存储、可信 origin、
 * 客户端 IP 和后台任务能力组装成 BackendContext，再调用 handleApi。
 * 认证、权限、路由分发和保存规则位于 services；Awilix 在那里为每次请求
 * 创建独立作用域，用户身份也只在该请求内缓存。
 *
 * 一、Cloudflare Workers 路径
 * event.context.cloudflare 提供当前请求的 D1/R2 绑定和 Worker 生命周期。
 * cloudflareStorage 将这些绑定适配成 Repository 与 ObjectStore 接口。
 * PUBLIC_ORIGIN 来自部署配置，客户端 IP 使用 Cloudflare 提供的请求头。
 * 后台任务交给 context.waitUntil，使快照回收能在响应结束后继续运行；
 * 任务的失败会被记录。每个 Worker 实例最多每小时触发一次孤立对象扫描，
 * 扫描本身有时间宽限，避免回收尚未完成元数据提交的新快照。
 *
 * 二、Node / Docker 路径
 * local 缓存 nodeStorage 的初始化 Promise，让并发请求共用同一次初始化
 * 和进程持有的 SQLite 连接。初始化失败时清空缓存，下一次请求可以重试。
 * #workspace-node-storage 由 Nuxt 构建配置选择：Node 指向 SQLite 实现，
 * Workers 指向失败保护模块，防止 SQLite 和文件系统依赖进入 Worker 产物。
 * Node 的 origin 与可信代理配置来自环境变量；客户端 IP 由 socket 地址和
 * 明确配置的可信代理共同确定。后台任务收集到 pending，在返回响应前等待
 * 完成；Node 没有 Worker 的 waitUntil 生命周期扩展能力。
 *
 * 三、请求体为何需要特殊处理
 * Nitro 2 的 Cloudflare 适配器只缓冲 POST、PUT、PATCH 请求体。
 * 对带 JSON 的 DELETE，转换后的虚拟 Node 流可能一直不结束，因此这里读取
 * Cloudflare 保留的原始 Request。其他方法的原始 body 已被 Nitro 消费，
 * 必须使用 toWebRequest 重建的请求。这两种来源不能统一替换成同一个来源，
 * 否则会影响画布删除或普通保存请求。
 *
 * 四、异常边界与资源归属
 * 外层 catch 记录初始化或平台适配异常，并返回不缓存的通用 JSON 500。
 * 业务错误由 handleApi 转换为对应的 HTTP 状态和错误码。
 * SQLite 连接属于 Node 进程，D1/R2 由平台管理；请求作用域结束时释放的是
 * 本次请求的服务实例，共享存储继续供后续请求使用。
 */
import { defineEventHandler, toWebRequest, sendWebResponse } from "h3";
import { handleApi } from "../services/api";
import { clientIp, publicOrigin } from "../services/security";
import {
  cloudflareStorage,
  type CloudflareBindings,
} from "../storage/cloudflare";
import {
  collectOrphans,
  type Repository,
  type ObjectStore,
} from "../storage/repository";

let local:
  | Promise<{
      repository: Repository;
      objects: ObjectStore;
    }>
  | undefined;

let lastCloudflareSweep = 0;

export default defineEventHandler(async (event) => {
  try {
    const cf = event.context.cloudflare as
      | {
          env: CloudflareBindings;
          request?: Request;
          context?: {
            waitUntil(p: Promise<unknown>): void;
          };
        }
      | undefined;

    // Nitro 2's Cloudflare adapter buffers only POST/PUT/PATCH. Its virtual Node
    // stream never ends for DELETE bodies; read the untouched platform request.
    // Other methods must use the reconstructed request because Nitro consumed them.
    const request =
      event.method === "DELETE" && cf?.request
        ? cf.request
        : toWebRequest(event);

    if (cf) {
      if (!cf.env?.DB || !cf.env.DATA)
        throw new Error("Missing Cloudflare storage bindings");

      const storage = cloudflareStorage(cf.env);

      const waitUntil = (promise: Promise<unknown>) => {
        const safe = promise.catch((error) =>
          console.error(
            "Background operation failed",
            error instanceof Error ? error.message : "unknown",
          ),
        );

        if (cf.context) cf.context.waitUntil(safe);
      };

      if (Date.now() - lastCloudflareSweep > 60 * 60 * 1000) {
        lastCloudflareSweep = Date.now();
        waitUntil(collectOrphans(storage.repository, storage.objects));
      }

      return sendWebResponse(
        event,
        await handleApi(request, {
          ...storage,
          publicOrigin: publicOrigin(
            cf.env.PUBLIC_ORIGIN,
            request.url,
            import.meta.dev,
          ),
          clientIp: request.headers.get("cf-connecting-ip") || "unknown",
          waitUntil,
        }),
      );
    }

    // Nitro alias includes SQLite only in the Node artifact; the Workers alias fails closed.
    local ??= import("#workspace-node-storage")
      .then((module) => module.nodeStorage())
      .catch((error) => {
        local = undefined;
        throw error;
      });

    const storage = await local;
    const pending: Promise<unknown>[] = [];

    const response = await handleApi(request, {
      ...storage,
      publicOrigin: publicOrigin(
        process.env.PUBLIC_ORIGIN,
        request.url,
        import.meta.dev,
      ),
      clientIp: clientIp(
        event.node.req.socket.remoteAddress,
        request.headers.get("x-forwarded-for"),
        process.env.TRUSTED_PROXY_IPS,
      ),

      waitUntil(p) {
        pending.push(
          p.catch((error) =>
            console.error(
              "Background operation failed",
              error instanceof Error ? error.message : "unknown",
            ),
          ),
        );
      },
    });

    // Node has no Worker lifetime extension. Finish durable cleanup before responding.
    await Promise.all(pending);

    return sendWebResponse(event, response);
  } catch (error) {
    console.error(
      "API initialization failed",
      error instanceof Error ? error.message : "unknown",
    );

    return sendWebResponse(
      event,
      Response.json(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "服务暂时不可用，请稍后重试",
          },
        },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      ),
    );
  }
});
