/**
 * Client 半边冒烟测试：不开浏览器，用一套最小 React 替身把桌宠渲染出来，
 * 再模拟「双击宠物 → 面板里点另一只宠物」这些交互，断言真的换了图。
 *
 *   node tools/client-smoke.mjs
 *
 * 为什么需要它：client.template.js 改完要重新构建（lib/client.js）+ 刷新页面，
 * 而「渲染炸了」「面板里点了没反应」「英文词典漏了 key」这类问题光看语法发现不了。
 * 这个脚本在命令行里就能确认：
 *   1. 构建产物渲染不抛错；
 *   2. 双击开面板、面板里的宠物按钮可点、切换后 <img> 真的换了宠物；
 *   3. 点「重扫」会按 refresh=1 问 Host，拿到的新花名册会进面板；
 *   4. 点「导入」会 POST /__import（带自定义头），新宠物自动切过去；
 *   5. 英文界面不会把漏掉的 key 原样显示出来；
 *   6. 一个素材都没有时显示自救卡片（导入 / 重扫），而不是一只裂图宠物。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 最小 React：够 client.template.js 用（按调用序号存 hooks，重渲染复用同一份 state）。 */
function createMiniReact() {
  const Fragment = Symbol('Fragment')
  let hooks = []
  let cursor = 0

  function createElement(type, props, ...children) {
    const normalized = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: { ...(props || {}), children: normalized } }
  }
  function useState(initial) {
    const index = cursor
    cursor += 1
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
    const set = (value) => {
      hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
    }
    return [hooks[index], set]
  }
  function useRef(initial) {
    const index = cursor
    cursor += 1
    if (!(index in hooks)) hooks[index] = { current: initial }
    return hooks[index]
  }
  function useMemo(factory) {
    cursor += 1
    return factory()
  }
  function useCallback(fn) {
    cursor += 1
    return fn
  }
  function useEffect() {
    cursor += 1
  }
  class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
    setState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch)
    }
  }

  return {
    createElement,
    useState,
    useRef,
    useMemo,
    useCallback,
    useEffect,
    useLayoutEffect: useEffect,
    Component,
    Fragment,
    /** 每次渲染前把 hooks 游标拨回 0（state 留着）。 */
    reset() {
      cursor = 0
    },
    /** 换一个组件实例时把 state 也清掉（否则不同 Root 之间会串 state）。 */
    clear() {
      hooks = []
      cursor = 0
    },
  }
}

const React = createMiniReact()

/** 把元素树走成一棵「宿主元素 + 文本」的普通树，顺便调用函数组件（类组件走 render()）。 */
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return { type: '#array', props: {}, text: '', children: node.map(render).filter(Boolean) }
  if (typeof node === 'string' || typeof node === 'number') {
    return { type: '#text', props: {}, text: String(node), children: [] }
  }
  if (typeof node.type === 'function') {
    const isClass = node.type.prototype && typeof node.type.prototype.render === 'function'
    if (isClass) {
      const instance = new node.type(node.props)
      return render(instance.render())
    }
    React.reset()
    return render(node.type(node.props))
  }
  const children = node.props.children
  const rendered = (Array.isArray(children) ? children : [children]).map(render).filter(Boolean)
  return { type: node.type, props: node.props, text: '', children: rendered }
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (node.type === '#text') return node.text
  return [node.text, ...(node.children || []).map(textOf)].join('')
}

function findAll(node, predicate, found = []) {
  if (node === null || node === undefined) return found
  if (node.type !== '#text' && node.type !== '#array' && predicate(node)) found.push(node)
  for (const child of node.children || []) findAll(child, predicate, found)
  return found
}

const byType = (root, type) => findAll(root, (node) => node.type === type)
const imgsOf = (root) => byType(root, 'img').map((node) => String(node.props.src))
const buttonsWithText = (root, needle) =>
  findAll(root, (node) => node.type === 'button' && textOf(node).includes(needle))

/** 假装加载客户端模块：造 window、调用 apply()、拿回它注册的 Root 组件。 */
async function loadClient(file, options) {
  const opts = options || {}
  let captured = null
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec
      },
    },
    localStorage: {
      getItem() {
        return null
      },
      setItem() {},
      removeItem() {},
    },
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  // tag：给模块 URL 挂个查询串，这样第二次加载同一个文件会重新执行（否则 ESM 命中缓存）
  await import(opts.tag === undefined ? pathToFileURL(file).href : `${pathToFileURL(file).href}?${opts.tag}`)
  if (captured === null) throw new Error(`${file} 没有调用 window.__ModuleLoader__.load()`)

  const required = { react: React }
  const module = captured.factory((id) => {
    if (id in required) return required[id]
    throw new Error(`客户端 require 了没准备的模块：${id}`)
  })

  // 词典按注册时的 id 存起来，bind() 就能返回真正的中文/英文文案，
  // 这样断言可以查「导入 / 重扫」这种人看得懂的字。
  // 顺手把「查了但词典里没有的 key」记下来 —— 界面会原样显示这个 key，等于漏翻译。
  const dicts = new Map()
  const missing = []
  const active = opts.active || 'zh'
  const locale = {
    register(namespace, id, dict) {
      dicts.set(id, dict)
      return () => dicts.delete(id)
    },
    bind() {
      return (key) => {
        const dict = dicts.get(active) || {}
        if (!Object.prototype.hasOwnProperty.call(dict, key)) missing.push(`${active}:${key}`)
        return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key
      }
    },
    getLocale() {
      return { active, locales: [{ id: 'zh' }, { id: 'en' }] }
    },
  }

  let Root = null
  // localeGate：模拟真实挂载顺序 —— 客户端插件是 immediately 挂的，
  // ctx.get('locale') 前 N 次可能返回 undefined，晚一拍才拿到服务。
  const gate = opts.localeGate || null
  let localeSeen = 0
  const ctx = {
    get(name) {
      if (name === 'locale') {
        localeSeen += 1
        if (gate !== null && localeSeen <= gate.n) return undefined
        return locale
      }
      return undefined
    },
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    slots: {
      inject(_slot, callback) {
        callback()
      },
      register(_descriptor, component) {
        Root = component
        return () => {}
      },
    },
  }
  module.apply(ctx)
  if (Root === null) throw new Error('客户端没有注册 shell.overlay 组件')
  return { Root, missing, dicts }
}

const cases = []

/** 渲染一次；换到另一个 Root（另一份模块实例）时把 state 清掉，避免串味。 */
let lastRoot = null
function draw(Root) {
  if (Root !== lastRoot) {
    React.clear()
    lastRoot = Root
  }
  React.reset()
  return render(React.createElement(Root, {}))
}

/** 等几轮微任务/宏任务，让按钮里的 async fetch 流程走完。 */
const flush = async () => {
  for (let round = 0; round < 4; round += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

// ── 1. 构建产物：正式的宠物数据 ──────────────────────────────────────────
const { Root } = await loadClient(path.join(packageRoot, 'lib', 'client.js'))
const built = await fsp.readFile(path.join(packageRoot, 'lib', 'client.js'), 'utf8')
const petsMatch = built.match(/const BUILT_PETS = (\[[^\n]*?\])/)
const petIds = petsMatch === null ? [] : JSON.parse(petsMatch[1]).map((pet) => pet.id)
const firstPet = petIds[0]
const secondPet = petIds.find((id) => id !== firstPet)

let tree = draw(Root)
cases.push(['渲染不抛错（构建产物）', true, `${byType(tree, 'div').length} 个节点`])
cases.push([
  '默认宠物出图',
  imgsOf(tree).length === 1 && imgsOf(tree)[0].startsWith(`/fish-pet/${firstPet}/`),
  imgsOf(tree)[0],
])
cases.push(['面板默认是关着的', buttonsWithText(tree, '重扫').length === 0, ''])

// 双击宠物 → 打开面板
const petBox = findAll(tree, (node) => typeof node.props.onDoubleClick === 'function')[0]
if (petBox === undefined) {
  cases.push(['双击能打开面板', false, '找不到绑了 onDoubleClick 的元素'])
} else {
  petBox.props.onDoubleClick({ preventDefault() {} })
  tree = draw(Root)
  const rescan = buttonsWithText(tree, '重扫')
  const imports = findAll(tree, (node) => node.type === 'button' && textOf(node).includes('导入'))
  cases.push(['双击能打开面板', rescan.length > 0 && imports.length > 0, `重扫=${rescan.length} 导入=${imports.length}`])
  cases.push([
    '花名册来源标成「构建时」（Host 没响应时的兜底）',
    textOf(tree).includes('构建时'),
    textOf(tree).includes('构建时') ? 'ok' : textOf(tree).slice(0, 80),
  ])
  cases.push([
    '面板列出了所有宠物',
    petIds.every((id) => buttonsWithText(tree, id).length > 0),
    petIds.join('、'),
  ])

  if (secondPet !== undefined) {
    // 点另一只宠物 → 图必须换过去
    const button = buttonsWithText(tree, secondPet).find((node) => typeof node.props.onClick === 'function')
    if (button === undefined) {
      cases.push(['点面板里的宠物能切换', false, `找不到 ${secondPet} 的按钮`])
    } else {
      button.props.onClick()
      tree = draw(Root)
      cases.push([
        '点面板里的宠物能切换',
        imgsOf(tree)[0].startsWith(`/fish-pet/${secondPet}/`),
        `${firstPet} -> ${imgsOf(tree)[0]}`,
      ])
      cases.push([
        '切换后仍然只播一张图（没有裂图占位）',
        imgsOf(tree).length === 1 && !imgsOf(tree)[0].endsWith('/fish-pet/'),
        imgsOf(tree)[0],
      ])
    }
  } else {
    cases.push(['点面板里的宠物能切换', true, '只有一只宠物，跳过（构建数据里多加一只即可覆盖）'])
  }

  const search = findAll(tree, (node) => node.type === 'input' && node.props.type === 'search')[0]
  cases.push(['面板有搜索框', search !== undefined, search === undefined ? '没有' : String(search.props.placeholder)])
}

// ── 2. 英文界面：词典漏了 key 会直接把 key 显示出来 ──────────────────────
const { Root: enRoot, missing: enMissing } = await loadClient(path.join(packageRoot, 'lib', 'client.js'), {
  active: 'en',
  tag: 'lang=en',
})
let enTree = draw(enRoot)
const enBox = findAll(enTree, (node) => typeof node.props.onDoubleClick === 'function')[0]
if (enBox !== undefined) enBox.props.onDoubleClick({ preventDefault() {} })
enTree = draw(enRoot)
cases.push([
  '英文词典没漏 key（漏了界面会原样显示 key）',
  enMissing.length === 0,
  enMissing.length === 0 ? 'ok' : `漏了 ${[...new Set(enMissing)].join('、')}`,
])

// ── 3. 面板里的「重扫 / 导入」：用假 fetch 真点一下 ────────────────────────
// 这里验证「点了按钮之后客户端会不会把新花名册接进来」；Host 那侧的接口行为由
// self-test.mjs 覆盖，两边合起来就是完整链路。
const fakeAssets = (pet) =>
  Array.from({ length: 2 }, (_value, index) => ({
    f: `${pet}/gif-${index}.gif`,
    u: `${pet}/gif-${index}.gif`,
    n: `动画 ${index}`,
    ms: 1200,
    pet,
  }))
const rosterWith = (pets, extra) => ({
  ok: true,
  version: 3,
  source: 'runtime',
  scanMs: 33,
  pets: pets.map((pet) => ({ id: pet, label: pet, count: 2 })),
  assets: pets.flatMap((pet) => fakeAssets(pet)),
  pools: Object.fromEntries(pets.map((pet) => [pet, { daze: [`${pet}/gif-0.gif`], roam: [`${pet}/gif-1.gif`] }])),
  warnings: [],
  res: {
    archives: [{ name: 'third-pet.zip', pet: 'third-pet', gifs: 0, extracted: false }],
    pending: ['third-pet.zip'],
    invalid: [],
  },
  ...(extra || {}),
})

const fetchCalls = []
const rosterReply = rosterWith([...petIds, 'third-pet'])
const importReply = rosterWith(['imported-pet'], {
  imported: ['imported-pet'],
  failures: [],
  report: ['解压 third-pet.zip -> assets/imported-pet/'],
})
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init: init || {} })
  const payload = String(url).includes('__import') ? importReply : rosterReply
  return { ok: true, status: 200, json: async () => payload }
}

const { Root: liveRoot } = await loadClient(path.join(packageRoot, 'lib', 'client.js'), { tag: 'fetch' })
let liveTree = draw(liveRoot)
const openBox = findAll(liveTree, (node) => typeof node.props.onDoubleClick === 'function')[0]
openBox.props.onDoubleClick({ preventDefault() {} })
liveTree = draw(liveRoot)

// 点「重扫」→ 花名册里多出 third-pet
const rescanButton = buttonsWithText(liveTree, '重扫').find((node) => typeof node.props.onClick === 'function')
rescanButton.props.onClick()
await flush()
liveTree = draw(liveRoot)
const scanCall = fetchCalls.find((entry) => entry.url.includes('__roster'))
cases.push([
  '点「重扫」→ 按 refresh=1 问 Host',
  scanCall !== undefined && scanCall.url.includes('refresh=1'),
  scanCall === undefined ? '没发请求' : scanCall.url,
])
cases.push([
  '重扫后新宠物出现在面板里，来源变成「运行时」',
  buttonsWithText(liveTree, 'third-pet').length > 0 && textOf(liveTree).includes('运行时'),
  `third-pet 按钮=${buttonsWithText(liveTree, 'third-pet').length}`,
])

// 点「导入」→ 解压出新宠物并自动切过去
const importButton = findAll(
  liveTree,
  (node) => node.type === 'button' && textOf(node).includes('导入') && typeof node.props.onClick === 'function',
)[0]
importButton.props.onClick()
await flush()
liveTree = draw(liveRoot)
const importCall = fetchCalls.find((entry) => entry.url.includes('__import'))
cases.push([
  '点「导入」→ POST /__import 且带自定义头',
  importCall !== undefined &&
    importCall.init.method === 'POST' &&
    importCall.init.headers['x-fish-pet'] === 'import' &&
    String(importCall.init.body).includes('force'),
  importCall === undefined ? '没发请求' : `${importCall.init.method} ${importCall.url} ${importCall.init.body}`,
])
cases.push([
  '导入后自动切到新宠物',
  imgsOf(liveTree)[0].startsWith('/fish-pet/imported-pet/'),
  imgsOf(liveTree)[0],
])
cases.push([
  '导入结果（宠物名）写在面板提示行上',
  textOf(liveTree).includes('imported-pet'),
  textOf(liveTree).includes('imported-pet') ? 'ok' : textOf(liveTree).slice(-70),
])

// ── 4. 模板原样加载 = 一个素材都没有，应该出现自救卡片 ────────────────────
const { Root: emptyRoot, missing: emptyMissing } = await loadClient(path.join(packageRoot, 'src', 'client.template.js'))
const emptyTree = draw(emptyRoot)
const emptyButtons = buttonsWithText(emptyTree, '导入')
cases.push(['没素材时不渲染裂图宠物', byType(emptyTree, 'img').length === 0, `${byType(emptyTree, 'img').length} 张 img`])
cases.push([
  '没素材时给自救卡片（导入 / 重扫）',
  emptyButtons.length > 0 && buttonsWithText(emptyTree, '重扫').length > 0,
  textOf(emptyTree).slice(0, 80),
])
cases.push([
  '中文词典也没漏 key',
  emptyMissing.length === 0,
  emptyMissing.length === 0 ? 'ok' : `漏了 ${[...new Set(emptyMissing)].join('、')}`,
])

// ── 5. locale 服务晚到（真实页面的顺序就是这样）：t() 必须自己补上 ────────
// 客户端插件是 immediately 挂载的，apply() 那一刻 ctx.get('locale') 可能是 undefined。
// 老写法会一辈子回退成原始 key（面板上写着 petSwap / size / poke），这里锁住这个行为。
const gate = { n: Number.POSITIVE_INFINITY }
const { Root: lateRoot, dicts: lateDicts } = await loadClient(path.join(packageRoot, 'src', 'client.template.js'), {
  tag: 'late-locale',
  localeGate: gate,
})
let lateTree = draw(lateRoot)
const rawText = textOf(lateTree)
cases.push([
  'locale 还没就绪时不崩（暂时显示原始 key）',
  byType(lateTree, 'img').length === 0 && rawText.includes('noAssetsHint'),
  rawText.slice(0, 42),
])
cases.push(['locale 还没就绪时不登记词典', lateDicts.size === 0, `dicts=${lateDicts.size}`])

// 服务晚一拍出现 → 下一次 t() 自己补登记 + 绑定
gate.n = 0
lateTree = draw(lateRoot)
const fixedText = textOf(lateTree)
cases.push([
  'locale 晚到后 t() 自己补上（不再显示原始 key）',
  fixedText.includes('没有桌宠素材') && !fixedText.includes('noAssetsHint'),
  fixedText.slice(0, 42),
])
cases.push([
  'locale 晚到后词典登记上了',
  lateDicts.size > 0,
  `dicts=${[...lateDicts.keys()].join(',')}`,
])

let failed = 0
for (const [label, ok, detail] of cases) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`)
}
console.log(failed === 0 ? `\n全部通过（${cases.length} 项）` : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
