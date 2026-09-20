/**
 * 蓝色大肥鱼桌宠 —— Host 半边。
 *
 * 做两件事：
 *   1. 把素材目录里的 GIF 以 HTTP 路由暴露给浏览器，让 Client 半边用 <img src>
 *      直接显示（浏览器自己缓存、自己流式解码），而不必把几 MB 的图片塞进 JSON RPC；
 *   2. 提供运行时花名册接口，这样「换宠物」不用重新构建、也不用改代码：
 *        GET  <prefix>/__roster   当前花名册：宠物列表 + 每个动画 + 每只宠物的池子
 *        POST <prefix>/__import   把 res/ 里的压缩包解压到 assets/，然后返回新花名册
 *      （面板里的「重扫 / 导入」就是这两个接口；数据由 lib/catalog.mjs 算，
 *       和构建脚本共用一份逻辑，保证两边永远一致。）
 *
 * 素材目录默认是包内的 `assets/`（用户把桌宠压缩包丢在 res/，由 Host 或构建脚本解压），
 * 也支持子目录 —— 桌宠包通常自带一层目录。解析规则：
 *   1) `GET <prefix>/<相对路径>` 直接命中；
 *   2) 否则按「文件名」在整棵素材树里找（扁平 URL 也能用）。
 * 目录外的路径、非 .gif、含分隔符/`..` 的名字一律 404，不做目录穿越。
 */
import { spawn } from 'node:child_process'
import { createReadStream, promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ARCHIVE_EXTENSIONS,
  archiveStatus,
  buildCatalog,
  importArchives,
  loadLoopCache,
  saveLoopCache,
} from './catalog.mjs'

/** Host 半边在 webServer 就绪后才激活。 */
export const inject = ['webServer']

/** 花名册的内存缓存时长：面板连点重扫不会每次都重扫磁盘。 */
const ROSTER_TTL_MS = 5000
/** POST /__import 的请求体上限（只用来传一个 force 布尔值）。 */
const MAX_BODY_BYTES = 4096
/** 自定义请求头：浏览器的跨站表单/图片请求发不出这个头，等于一个廉价的 CSRF 挡板。 */
const IMPORT_HEADER = 'x-fish-pet'

function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

/** 缺省素材目录：包内的 assets/（运行时素材，由 res/ 里的压缩包解压而来）。 */
function defaultAssetRoot() {
  return path.join(packageRoot(), 'assets')
}

function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const assetRoot = path.resolve(
    typeof raw.assetDir === 'string' && raw.assetDir.trim() !== '' ? raw.assetDir : defaultAssetRoot(),
  )
  const resRoot = path.resolve(
    typeof raw.resDir === 'string' && raw.resDir.trim() !== '' ? raw.resDir : path.join(packageRoot(), 'res'),
  )
  const rawPrefix = typeof raw.routePrefix === 'string' && raw.routePrefix.trim() !== '' ? raw.routePrefix.trim() : '/fish-pet'
  const routePrefix = `/${rawPrefix.replace(/^\/+|\/+$/g, '')}`
  const cacheSeconds = Number.isFinite(raw.cacheSeconds) ? Math.max(0, Math.floor(raw.cacheSeconds)) : 604800
  // 可选：assets/ 空的时候自动跑一次生成脚本（解压 res/ 里的压缩包 + 重新生成客户端数据）。
  const buildOnStart = raw.buildOnStart === true
  return { assetRoot, resRoot, routePrefix, cacheSeconds, buildOnStart }
}

function send(res, status, body, headers) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(text)
}

/** 把请求体读成 JSON（有大小上限；读不出对象就返回空对象）。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve({})
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => resolve({}))
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        resolve({})
      }
    })
  })
}

export function apply(ctx, config) {
  const { assetRoot, resRoot, routePrefix, cacheSeconds, buildOnStart } = normalizeConfig(config)
  const rosterPath = `${routePrefix}/__roster`
  const importPath = `${routePrefix}/__import`

  /** 谁在取图：用来判断「浏览器真的把桌宠画出来了」，而不只是注册成功。 */
  const stats = { assetHits: 0, browserHits: 0, lastAsset: null, lastAssetAt: null, lastUserAgent: null }
  function noteHit(req, name) {
    const agent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : ''
    stats.assetHits += 1
    if (!/powershell|curl|node|python/i.test(agent)) stats.browserHits += 1
    stats.lastAsset = name
    stats.lastAssetAt = new Date().toISOString()
    stats.lastUserAgent = agent.slice(0, 160)
  }

  /**
   * 整棵素材树的索引：文件名 → 相对路径（POSIX 分隔符）。
   * 缓存 10 秒，解压出新素材后自动跟上。
   */
  const indexCache = { at: 0, files: new Map() }
  async function indexFiles(force) {
    if (force !== true && Date.now() - indexCache.at < 10000) return indexCache.files
    const files = new Map()
    async function walk(dir, prefix) {
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative)
        else if (/\.gif$/i.test(entry.name) && !files.has(entry.name)) files.set(entry.name, relative)
      }
    }
    await walk(assetRoot, '')
    indexCache.at = Date.now()
    indexCache.files = files
    return files
  }

  // ── 花名册 ──────────────────────────────────────────────────────────────
  // 扫描要读每个 GIF 才能算出一轮时长（157 个 / 460 MB 冷启动约 5 秒），
  // 所以：进程内缓存 + 磁盘上的时长缓存（assets/.fish-pet-loops.json），
  // 第二次扫描起只 stat 不读文件。
  const loopCacheFile = path.join(assetRoot, '.fish-pet-loops.json')
  let loopCache = null
  const rosterCache = { at: 0, data: null, scanMs: 0 }

  async function getCatalog(force) {
    if (force !== true && rosterCache.data !== null && Date.now() - rosterCache.at < ROSTER_TTL_MS) {
      return rosterCache.data
    }
    if (loopCache === null) loopCache = await loadLoopCache(loopCacheFile)
    const started = Date.now()
    const data = await buildCatalog({ assetsRoot: assetRoot, loopCache })
    rosterCache.scanMs = Date.now() - started
    rosterCache.at = Date.now()
    rosterCache.data = data
    await saveLoopCache(loopCacheFile, loopCache, data.loopKeys)
    return data
  }

  /** res/ 里压缩包的状态：面板用它显示「还有几个包没导入」。 */
  async function resState() {
    const archives = await archiveStatus({ resRoot, assetsRoot: assetRoot })
    return {
      dir: path.basename(resRoot),
      archives: archives.map((item) => ({
        name: item.name,
        pet: item.pet,
        gifs: item.gifs,
        extracted: item.extracted,
        reason: item.reason,
      })),
      pending: archives.filter((item) => item.pet !== '' && !item.extracted).map((item) => item.name),
      invalid: archives.filter((item) => item.pet === '').map((item) => item.name),
    }
  }

  /** 花名册响应体：Client 半边拿它直接替换构建时写死的数据。 */
  async function rosterPayload(catalog, extra) {
    return {
      ok: catalog.pets.length > 0,
      version: 3,
      route: routePrefix,
      source: 'runtime',
      generatedAt: new Date().toISOString(),
      scanMs: rosterCache.scanMs,
      pets: catalog.pets,
      assets: catalog.assets,
      pools: catalog.pools,
      warnings: catalog.warnings,
      res: await resState(),
      ...extra,
    }
  }

  // 页面刷新之后往往马上就来要花名册，先在后台把磁盘缓存捂热。
  void (async () => {
    try {
      await getCatalog(true)
    } catch (error) {
      ctx.logger?.warn?.('fish-pet: 花名册预热失败：%s', error instanceof Error ? error.message : String(error))
    }
  })()

  async function statGif(full) {
    try {
      const info = await fsp.stat(full)
      if (!info.isFile()) return undefined
      return { full, size: info.size, mtimeMs: info.mtimeMs }
    } catch {
      return undefined
    }
  }

  /**
   * 把 URL 路径解析成一个真实的 GIF 文件；任何可疑输入返回 undefined。
   * @param {string} pathname 请求路径名。
   * @returns {Promise<{full: string, size: number, mtimeMs: number} | undefined>}
   */
  async function resolveAsset(pathname) {
    if (pathname !== routePrefix && !pathname.startsWith(`${routePrefix}/`)) return undefined
    let name = pathname.slice(routePrefix.length).replace(/^\/+/, '')
    if (name === '') return undefined
    try {
      name = decodeURIComponent(name)
    } catch {
      return undefined
    }
    if (!/\.gif$/i.test(name) || name.includes('\0')) return undefined
    const segments = name.split('/')
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('\\'))) {
      return undefined
    }

    // 1) 直接按相对路径找
    const direct = path.resolve(assetRoot, ...segments)
    if (direct.startsWith(`${assetRoot}${path.sep}`)) {
      const found = await statGif(direct)
      if (found !== undefined) return found
    }

    // 2) 按文件名在整棵树里找（用户可能只给文件名）
    const files = await indexFiles(false)
    const relative = files.get(segments[segments.length - 1])
    if (relative === undefined) return undefined
    return statGif(path.resolve(assetRoot, ...relative.split('/')))
  }

  /**
   * 面板里的「导入 res/」：把 res/ 里的压缩包解压到 assets/。
   * 请求体只能是 { force?: boolean } —— 目标路径完全由压缩包自己的文件名决定，
   * 所以这个接口没法被拿来往任意位置写文件。
   * 双重挡板：必须带 x-fish-pet 头（跨站请求发不出去，会先撞 CORS 预检）+ Origin 必须同源。
   */
  let importInFlight = null
  async function handleImport(req, res) {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
    const host = typeof req.headers.host === 'string' ? req.headers.host : ''
    if (origin !== '' && host !== '' && origin !== `http://${host}` && origin !== `https://${host}`) {
      send(res, 403, { ok: false, error: 'cross-origin import is not allowed' })
      return
    }
    if (typeof req.headers[IMPORT_HEADER] !== 'string') {
      send(res, 403, { ok: false, error: `missing ${IMPORT_HEADER} header` })
      return
    }
    const body = await readJsonBody(req)
    const force = body.force === true
    try {
      // 同一时刻只跑一次解压，重复点击就复用同一个 promise。
      if (importInFlight === null) {
        importInFlight = (async () => {
          try {
            return await importArchives({ resRoot, assetsRoot: assetRoot, force })
          } finally {
            importInFlight = null
          }
        })()
      }
      const result = await importInFlight
      indexCache.at = 0 // 新素材要能被按文件名兜底找到
      const catalog = await getCatalog(true)
      ctx.logger?.info?.(
        'fish-pet: 导入完成，新增/更新 %d 只宠物（%s）',
        result.imported.length,
        result.extracted.map((item) => item.archive).join('、') || '无',
      )
      for (const line of result.report) ctx.logger?.info?.('fish-pet: %s', line)
      for (const failure of result.failures) ctx.logger?.warn?.('fish-pet: %s 失败：%s', failure.archive, failure.reason)
      send(
        res,
        200,
        await rosterPayload(catalog, {
          forced: force,
          imported: result.imported,
          report: result.report,
          failures: result.failures,
        }),
      )
    } catch (error) {
      ctx.logger?.warn?.('fish-pet: 导入失败：%s', error instanceof Error ? error.message : String(error))
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: routePrefix,
      async handler(req, res) {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const pathname = url.pathname

          // ── 面板接口 ────────────────────────────────────────────────────
          if (pathname === rosterPath || pathname === `${rosterPath}/`) {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              send(res, 405, 'method not allowed', { allow: 'GET, HEAD' })
              return
            }
            const catalog = await getCatalog(url.searchParams.has('refresh'))
            const payload = await rosterPayload(catalog)
            if (req.method === 'HEAD') {
              res.writeHead(payload.ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8' })
              res.end()
              return
            }
            send(res, payload.ok ? 200 : 500, payload)
            return
          }
          if (pathname === importPath || pathname === `${importPath}/`) {
            if (req.method !== 'POST') {
              send(res, 405, 'method not allowed', { allow: 'POST' })
              return
            }
            await handleImport(req, res)
            return
          }

          // ── 路由根：不含绝对路径的健康检查，方便确认 Host 半边活着 ──────
          if (pathname === routePrefix || pathname === `${routePrefix}/`) {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              send(res, 405, 'method not allowed', { allow: 'GET, HEAD' })
              return
            }
            const files = await indexFiles(true)
            const animations = files.size
            const resStateNow = await resState()
            const resArchives = resStateNow.archives.length
            const catalog = rosterCache.data
            send(res, animations > 0 || catalog !== null ? 200 : 500, {
              ok: animations > 0,
              version: 3,
              route: routePrefix,
              assetRoot: path.basename(assetRoot),
              recursive: true,
              animations,
              // 没素材但 res/ 里有压缩包 = 需要导入一次（面板上就能点，不必跑命令行）
              needsBuild: animations === 0 && resArchives > 0,
              resArchives,
              pendingImports: resStateNow.pending,
              buildOnStart,
              pets: (catalog ? catalog.pets.map((pet) => pet.id) : null) ?? petsOnDisk(files),
              roster: {
                path: rosterPath,
                importPath,
                cached: rosterCache.data !== null,
                scanMs: rosterCache.scanMs,
                pets: catalog ? catalog.pets.length : 0,
              },
              cacheSeconds,
              stats,
            })
            return
          }

          if (req.method !== 'GET' && req.method !== 'HEAD') {
            send(res, 405, 'method not allowed', { allow: 'GET, HEAD' })
            return
          }

          const asset = await resolveAsset(pathname)
          if (asset === undefined) {
            send(res, 404, 'not found')
            return
          }
          noteHit(req, path.relative(assetRoot, asset.full))

          const etag = `W/"${asset.size.toString(16)}-${Math.floor(asset.mtimeMs).toString(16)}"`
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { etag, 'cache-control': `public, max-age=${cacheSeconds}` })
            res.end()
            return
          }

          const headers = {
            'content-type': 'image/gif',
            'content-length': asset.size,
            'cache-control': `public, max-age=${cacheSeconds}`,
            etag,
            'last-modified': new Date(asset.mtimeMs).toUTCString(),
          }
          if (req.method === 'HEAD') {
            res.writeHead(200, headers)
            res.end()
            return
          }
          res.writeHead(200, headers)
          const stream = createReadStream(asset.full)
          stream.on('error', () => res.destroy())
          stream.pipe(res)
        } catch (error) {
          ctx.logger?.warn?.('fish-pet asset request failed: %s', error instanceof Error ? error.message : String(error))
          if (!res.headersSent) send(res, 500, 'internal error')
          else res.destroy()
        }
      },
    }),
  )

  ctx.logger?.info?.('fish-pet assets served from %s at %s（花名册 %s）', assetRoot, routePrefix, rosterPath)

  // ── 启动自检 ────────────────────────────────────────────────────────────
  // 素材现在有两条来源：面板里点「导入」（运行时解压）/ 命令行跑构建脚本。
  // 这里只负责把情况说清楚，别让用户对着一只空宠物猜。
  void (async () => {
    try {
      const files = await indexFiles(true)
      if (files.size > 0) return
      const archives = await countArchives()
      if (archives === 0) {
        ctx.logger?.warn?.(
          'fish-pet: 没有素材，%s 里也没有压缩包。把桌宠包（.7z/.zip）放进 res/，然后在桌宠面板里点「导入」（或跑 node tools/build-client.mjs）。',
          resRoot,
        )
        return
      }
      if (buildOnStart) {
        ctx.logger?.info?.('fish-pet: assets/ 是空的，按 buildOnStart 自动构建（res/ 有 %d 个压缩包）', archives)
        const result = await runBuildScript()
        await indexFiles(true)
        if (result.ok) ctx.logger?.info?.('fish-pet: 自动构建完成，刷新页面即可看到素材')
        else ctx.logger?.warn?.('fish-pet: 自动构建失败（%s）；手动跑 node tools/build-client.mjs 看原因', result.reason)
        return
      }
      ctx.logger?.warn?.(
        'fish-pet: assets/ 里没有素材，但 res/ 有 %d 个压缩包。在桌宠面板里点「导入」即可解压（也可以跑 node tools/build-client.mjs）。',
        archives,
      )
    } catch (error) {
      ctx.logger?.warn?.('fish-pet: 启动自检失败：%s', error instanceof Error ? error.message : String(error))
    }
  })()

  /** 数一数 res/ 里有多少个压缩包。 */
  async function countArchives() {
    try {
      const entries = await fsp.readdir(resRoot, { withFileTypes: true })
      return entries.filter((entry) => entry.isFile() && ARCHIVE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
        .length
    } catch {
      return 0
    }
  }

  /** 从索引里归纳出宠物目录（顶层目录名）。 */
  function petsOnDisk(files) {
    const pets = new Set()
    for (const relative of files.values()) {
      const slash = relative.indexOf('/')
      pets.add(slash === -1 ? 'default' : relative.slice(0, slash))
    }
    return [...pets].sort()
  }

  /** 跑一次生成脚本（构建：解压 res/ → assets/，并重新生成 lib/client.js）。 */
  function runBuildScript() {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(process.execPath, [path.join(packageRoot(), 'tools', 'build-client.mjs')], {
          cwd: packageRoot(),
          stdio: 'ignore',
        })
      } catch (error) {
        resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) })
        return
      }
      child.on('error', (error) => resolve({ ok: false, reason: error.message }))
      child.on('exit', (code) => resolve({ ok: code === 0, reason: `exit ${code}` }))
    })
  }
}
