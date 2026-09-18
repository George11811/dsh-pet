# 蓝色大肥鱼桌宠（dsh-fish-pet）

把素材文件夹里的 157 张 GIF 做成一个悬浮在 DSH Web 界面上的桌宠。
它是**装进当前 profile 的插件**（bundle），所以这个 profile 下的每个会话都能看到它。

## 状态机

世界状态来自 `shell.overlay` 槽给的标准 props `useSessionStatus`（每个会话的
`running` / `pendingInteraction` / `completionUnread`），压成一个字符串后驱动宠物：

| DSH 状态 | 怎么判断 | 宠物在干嘛 |
| --- | --- | --- |
| `attention` | 有会话在等你回答（审批/提问） | 期待、招手、摇铃、问号、紧张 |
| `running` | 有会话正在干活 | **开工锁一个动作**：先「思考」，6 秒后切一次到「干活」，然后整个任务都用同一个动作，不再换（`THINK_LEAD_MS = 0` 就是一个动作到底）；同时气泡常驻一行 `● 干活中 12s` 的状态条 |
| `done` | 有后台[build-client.mjs](tools/build-client.mjs)会话刚干完、还没看过 | 举着通知/红包/礼物提醒一阵子（25 秒后回去过日子） |
| `idle` | 什么都没发生 | 过「生活」，见下表 |

宠物自己的状态优先级更高：
**你固定选的动画 > 被拎着 > 被点（卖萌）> 刚被放下 > 刚干完（庆祝）> 世界状态 > 生活**。

- **被拎着**（`hold` 池：害怕、惊吓、紧张、汗、头晕、问号）：拎起来的那一刻抽一个，
  **整段拖拽只播这一个**，同时鱼会歪 6°、稍微放大，跟手移动。
- **刚被放下**（`drop` 池：被击中×4、惊吓、头晕、生气、反转、死亡、自我安慰）：松手时再抽一个，
  **整段只播这一个**，播满它自己那一轮 GIF（至少 1.4 秒）才结束；松手瞬间另有一次性落地回弹
  （`@keyframes dsh-fish-pet-drop`）。这期间再点它，卖萌优先。

两个状态都只有一次「抽签」，之后不换动作 —— 拖动和放下各是一个动作，不是一个轮播。

`idle` 时它在几种「生活」之间切换，每段持续几十秒到几分钟，池子见 `tools/build-client.mjs`：

| 生活 | 内容 |
| --- | --- |
| 睡觉 | 睡觉三阶段 + 工作(小睡)，最长的一段 |
| 干饭 | 吃甜甜圈/西瓜/爆米花、馋(刀叉/筷子)、喝饮料、蛋糕 |
| 唱歌蹦迪 | 唱歌、吉他、四种跳舞、荧光棒、散味舞 |
| 摸鱼 | 带薪拉屎(简单/困难)、打游戏、静音、驾驶、摇可乐 |
| 发呆 | 呆 1/2/3、呆(贴纸)、六七、冒泡、眨眼、舔舔、Popcat、一切都好 |
| 搞事 | 小丑、拖鞋、胶带、垃圾桶、按钮、墨镜系列、折扇、要米、情书、催眠 |
| 瞎逛 | 剩下没被任何池子收留的 17 个（被击中、哭、笑、死亡、复活节…） |

## 会说话

台词库在 `src/client.template.js` 的 `PHRASES`（中英两套，池名和状态一一对应，`{n}`
会替换成真实信息）：

| 什么时候说 | 说什么 |
| --- | --- |
| 进入新状态 | 干活 → 「开始动手了，别催」；思考 → 「让我想想……这个循环为什么死不掉」；等你回答 → 「有 {n} 个地方等你拍板」；刚干完 → 「刚干完一个，去看看？」 |
| 换一种「生活」 | 睡觉/干饭/唱歌/摸鱼/发呆/搞事/瞎逛各有一组；另外 1/4 概率不说这件事，改成自言自语（「今天有 {n} 个会话陪着我」） |
| 用户交互（立即，无冷却） | 点它 → 卖萌台词；拎起来 → 「放我下来！我怕高」；放下 → 「呜……你摔我」；从列表固定动作 → 「好，我就一直这样」；🐟 放出来 → 「我回来了！想我没」 |
| 收工 | 会话从干活变空闲时 → 先「搞定！撒花🎉」，4.6 秒后**汇报本次数据**：`这次干了 1 分 23 秒，写了 3.4k tokens` |
| **干活期间的实时播报** | 跟着当前会话的**事件流**走（见下）：`reasoning-delta` → 「让我捋一捋…」；`text-delta` → 「开始写结论了」；`tool/call` → 按工具分类（读文件「翻一下 {x}」、搜索「在找 {x}」、改代码「动手改 {x}」、跑命令「跑一下 {x}」、联网、计划、技能、子代理、提问、插件）；`tool/result` 成功 → 「过了」；失败 → 直接把真实原因说出来「报错了：{r}」 |

### 实时播报的数据来源

客户端会话控制器给了当前会话的事件流：`ctx.sessions.binding(id).eventSource`
（`{ entries, revision }` + `subscribe`）。桌宠盯**正在干活的会话**，没有的话盯主视图里那个，
每次窗口变更只看最新一条事件，翻成「一个瞬间」再挑台词：

| 事件 | 瞬间 | 台词池 |
| --- | --- | --- |
| `assistant/live-chunk`（`reasoning-delta`） | 在想 | `mThink` |
| `assistant/live-chunk`（`text-delta`） | 在写答案 | `mWrite` |
| `tool/call` | 叫了工具 | `mRead`/`mSearch`/`mEdit`/`mRun`/`mWeb`/`mPlan`/`mLearn`/`mDelegate`/`mAsk`/`mPlugin`/`mTool` |
| `tool/result` | 成了 / 炸了 | `mOk` / `mFail`（有 `error.reason` 时用 `mFailWhy`） |
| `assistant/message`（`interrupted`） | 被打断 | `mFail` |

`{x}` 会替换成真实细节（从工具参数里抠：文件名、命令前两个词、搜索词、URL），
`{r}` 是工具报的错误原因。播报有自己的节奏：**至少间隔 15 秒**，并且有 30% 概率故意不说话 ——
否则就成了全程解说。工具名到分类的映射表是 `TOOL_CATEGORY`，加一行就能支持新工具。

规则与开关：

- **收工汇报**：耗时是本地算的（开工到收工的墙钟时间），token 用的是宿主投到客户端的
  `projectionValues.tokenUsage`（会话累计），所以**收工时取差值** = 这次干活花的量；
  跨会话求和，所以子代理也算进去。拿不到 token 就只报耗时（`reportTime` 台词池）。
- **常驻状态条**：干活期间气泡不会消失，顶部固定一行 `● 干活中 12s`（小圆点脉动、秒数实时走）；
  等你回答时同样常驻 `● 等你回答`。其余时间气泡只在说话时出现。
- 状态机自己触发的台词有 **9 秒冷却**，且只在「该说什么」真的变化时开口 ——
  同一个状态里换动作不会说话（否则又变成叨叨）。干活期间就是「思考 → 干活」各一句。
- 点气泡 = 再说一句；面板按钮行有 `说话：开/关` 和 `说一句`。开关记在 localStorage。
- 气泡默认挂在鱼**上方**，面板占了上方时自动让到下方；台词越长挂得越久（2.6–9 秒）。

## 颜文字

台词不逐句手写颜文字，而是**按情绪挂**：每个台词池在 `POOL_MOOD` 里对应一种情绪
（happy / shy / sad / panic / sleepy / think / work / plead / proud），说话时从
`KAOMOJI` 里对应那一组随机挑一个接在后面。

- 触发概率 `KAOMOJI_CHANCE = 0.75`（留一点白，不然每句都花里胡哨）
- 句子本身以 `)` 或 `）` 结尾（比如「正在思考（其实在发呆）」）就不叠，避免括号打架
- **气泡描边也跟着情绪变色**：`MOOD_TINT` 把情绪色用 `color-mix` 混进主题描边色，
  所以深色/浅色主题都压得住；浏览器不支持 `color-mix` 时自动退回普通描边

想加颜文字：往 `KAOMOJI` 对应情绪的数组里塞就行，不用动任何逻辑。

## 怎么玩

| 动作 | 效果 |
| --- | --- |
| 拖动 | 移动位置（位置记在浏览器 localStorage，刷新还在）；**拎起来是一个状态**：歪着、放大、挣扎；松手后是另一个状态：落地回弹 + 晕一会儿（约 3.6 秒） |
| 单击 | 卖萌（害羞、比心、舔舔、点赞…），几秒后回到当前状态；**永远优先响应** —— 即使固定了某个动画、或刚被放下，也会先卖萌再回到本该播的动作 |
| 双击 / 右键 | 打开面板 |
| 面板 | 开在鱼**上方**（上方空间不够就开到下方），按那一侧的空间限高（最高 540px），所以永远不会盖住鱼、也不会顶出屏幕；动画列表固定 24px 行高、自己滚动 |
| 面板里的「桌宠」一行 | 多只桌宠时的切换按钮（点一下就换，纯前端、立即生效，选中项记在 localStorage） |
| 面板标题栏的 `i` | 展开/收起诊断行：`诊断：槽 props · 会话78 · 干活0 · 等待0 · 未读0 · 动画157` |
| 气泡 | 她说话的地方；点一下＝再说一句；干活/等你回答时顶部有常驻状态条 |
| 面板第二行 | 实时显示 `DSH：正在干活 · 宠物：睡觉`，用来确认状态机真的跟着 DSH 走 |
| 面板里点某个动画 | 固定播放该动作（点「恢复自动」回到状态机） |

节奏档位（安静 / 正常 / 活泼）控制一段生活持续多久、每个动作待多久：
安静 = 一段生活 90–180 秒、每个动作 10 秒；活泼 = 30–70 秒、5 秒。
记在 localStorage，默认「安静」。

界面文字跟着 GUI 语言走（内置语言 id 是 `zh` / `en`，词典按 `locale.getLocale()`
里实际注册的语言逐个登记，避免回退成英文）。

藏起来之后右下角会留一个 🐟 小按钮，点一下把鱼放出来。

## 目录结构

```
dsh-fish-pet/
├── res/                        # ← 素材库：桌宠压缩包丢这里（.7z / .zip / .rar / .tar*）
│   └── fat-fish.7z
├── assets/                     # ← 运行时素材：每个包解出一个同名目录＝一只桌宠
│   └── fat-fish/               #   157 个 GIF（拍平后，稳定是 assets/<宠物>/*.gif）
├── package.json                # bundle 声明：dsh.bundle.patch + dsh.client
├── cordis.patch.yml            # 插入 fish-pet 行 + assetDir 配置
├── lib/
│   ├── index.js                # Host 半边：/fish-pet/<文件名> 路由，递归提供素材
│   └── client.js               # 生成物：浏览器实际加载的 Client 半边（别手改）
├── src/client.template.js      # Client 半边的源码（改这个）
└── tools/
    ├── build-client.mjs        # res/ → 解压 → assets/ → 扫描 → 分池 → 生成 lib/client.js
    └── self-test.mjs           # Host 半边自测（不用启动 dsh）
```

## 初始化 / 加宠物：一条命令

```powershell
node tools/build-client.mjs                    # res/ → assets/，再生成 lib/client.js
node tools/build-client.mjs --force            # 压缩包没变也重新解压
node tools/build-client.mjs --strict           # POOLS 名字对不上就当失败
node tools/build-client.mjs --res <目录> --assets <目录>
```

脚本干四件事：

1. **解压**：`res/` 下每个压缩包解到 `assets/<包名>/`。已有解压结果且比压缩包新就跳过。
   解压器按顺序探测：`7z`/`7za`/`7zr`/`7zz` → `C:\Program Files\7-Zip\7z.exe` → `tar`。
2. **拍平**：包内自套的一层目录（这个包就是 `assets/`）会被拍平，保证是稳定的
   `assets/<宠物>/*.gif` —— 宠物多了也不会各长一个样。
3. **扫描**：`assets/` 下**每个顶层目录 = 一只桌宠**，递归找它的 GIF；解析帧延时算一轮时长；
   显示名 = 去掉「该宠物所有文件名的公共前缀（通常是宠物名）+ 导出时间戳」。
4. **分池 + 生成**：按显示名把动画分进状态机的池子（每只宠物一套）。名字对不上的宠物，
   脚本会把没人认领的动画**轮流填进空池子**（保证每个状态都有动作），并打印警告；
   加 `--strict` 才把警告当失败。最后写出 `lib/client.js`。

### 换 / 加一只桌宠（运行时切换）

1. 把新包丢进 `res/`；
2. `node tools/build-client.mjs`；
3. 刷新页面（Ctrl+R）；
4. 面板里出现「桌宠」一行按钮，点一下就换 —— **纯前端切换，不用重新生成、不用重启**。
   选中的宠物记在 localStorage，刷新后还在。

多只宠物会一起被提供（`assets/<宠物>/` 各自独立），客户端只显示当前选中的那只。
同名的 GIF 之间互不影响（宠物目录不同）。

### 重启 dsh 会不会自动初始化？

**默认不会。** 解压 `res/` → 扫描 → 重新生成 `lib/client.js` 是**构建步骤**，只有
`node tools/build-client.mjs` 会做；重启 dsh 只是重新加载插件。所以删掉 `assets/` 里的东西
之后重启，得到的就是「没有素材」的状态。为此加了两道防线：

| 场景 | 表现 |
| --- | --- |
| `assets/` 空、`res/` 有压缩包 | Host 启动时记一条**明确警告**（含该跑的命令），健康检查里 `needsBuild: true`、`resArchives: N` |
| 想让启动自动补上 | 把 `config.buildOnStart` 设为 `true`：启动发现 `assets/` 空就**后台**跑一次生成脚本（不阻塞启动，失败只记日志） |
| `assets/` 和 `res/` 都空 | 警告提示把桌宠包放进 `res/` |
| 生成数据还在但 GIF 取不到（素材被删/assetDir 指错） | 客户端连续 3 次加载失败后，在气泡位置显示「桌宠素材加载失败 —— 先跑 node tools/build-client.mjs」，可关闭 |
| 生成数据里一个动画都没有 | 直接显示「没有桌宠素材 —— 先跑 node tools/build-client.mjs」，不渲染坏掉的宠物 |

## 为什么要有 Host 半边

素材一共几百 MB，单张最大 8 MB。全部塞进客户端代码或走 JSON RPC 都不现实，
所以 Host 半边在素材目录上挂一条 HTTP 前缀路由：

```
GET /fish-pet/<文件名>       → image/gif（带 ETag / 长缓存）
GET /fish-pet/<相对路径>      → 同上，路径式访问也行
GET /fish-pet/               → {"ok":true,"version":2,"animations":157,...}  健康检查
```

解析顺序：先按**相对路径**直接命中，再按**文件名**在整棵素材树里找。因此客户端生成的
URL 只用文件名 —— 素材换宠物目录、换压缩包重新解压，已生成的 URL 都不用变。
安全性：非 `.gif`、含 `..`／分隔符／控制字符的名字一律 404，解析结果必须落在素材目录内。

改完 Host 代码可以先跑自测，不用启动 dsh：

```powershell
node tools/self-test.mjs      # 11 项：递归查找、相对路径、穿越防护、ETag/304、HEAD、健康检查…
```

## 改交互

池子的**语义**（优先级、停留时长、生活持续多久、说什么）在 `src/client.template.js` 的
`ACTIVITIES` / `RATE_PRESETS` / `POOLS` 用法 / `plan()` 里；改完重新跑生成脚本 + 刷新页面。

## 配置

路由前缀、缓存时长、素材目录都在 `cordis.patch.yml` 的 `config` 里。

- `assetDir`：**留空**（默认）→ `<包>/assets`，并且**递归查找**，也就是
  `assets/<每只宠物>/*.gif` 全都能提供 —— 多宠物切换的正常状态，当前就是这个。
- `resDir`：素材库目录，默认 `<包>/res`。
- `cacheSeconds`：浏览器缓存秒数。
- `buildOnStart`：`assets/` 空时是否在启动时自动构建一次（默认 `false`，见上）。

## 改完什么时候生效

| 改了什么 | 生效方式 |
| --- | --- |
| `lib/client.js` / `src/client.template.js` | **刷新页面**（Ctrl+R） |
| `cordis.patch.yml` 的 `config` | **热生效**（开关一次 bundle 即可，实测有效） |
| `lib/index.js`（Host 半边代码） | **需要重启 dsh**：已加载的 JS 模块代不会因为改文件或开关插件而重新 import |
| `tools/build-client.mjs` / `self-test.mjs` | 下次运行即生效 |

## 诊断与排错

`GET /fish-pet/` 返回 `{ ok, version, route, assetRoot, recursive, animations, needsBuild,
resArchives, buildOnStart, pets, stats }`：

- `version: 2` + `recursive: true` → 新的 Host 代码已生效（递归查找、多宠物）
- `animations` → 整棵素材树的 GIF 数；为 0 且 `needsBuild: true` 就是缺素材，跑生成脚本
- `pets` → 认出来的宠物目录名
- `stats.browserHits` → 浏览器侧取图次数，能确认桌宠真的在页面上取图

`node tools/self-test.mjs` 可以在不启动 dsh 的情况下验证 Host 半边的路由行为。

- **`node tools/build-client.mjs` 报「解压失败」**：装个 7-Zip（`7z.exe`）最省事。
- **素材换了但页面没变**：先跑生成脚本，再 **Ctrl+R**（浏览器缓存了 `lib/client.js`）。
- **桌宠图片 404**：看 `GET /fish-pet/` 的 `animations`；为 0 就是 `assetDir` 指错了目录。
- **加了宠物但面板没有切换按钮**：面板里的「桌宠」一行只在宠物数 > 1 时出现，先确认
  `assets/` 下确实多了目录、并且重新跑过生成脚本。

## Git：什么提交、什么忽略

`.gitignore` 的取舍（都有注释说明理由）：

| 路径 | 提交？ | 理由 |
| --- | --- | --- |
| `src/` `lib/index.js` `tools/` `package.json` `cordis.patch.yml` `README.md` | ✅ | 源码与配置 |
| `lib/client.js` | ✅ | **是生成物但必须提交**：`package.json` 的 `exports["./client"]` 指向它，忽略掉全新克隆会客户端模块加载失败（隔壁 refs-shelf 和 dsh 自带的包也都提交 `lib/`）。代价是每次重建有一坨生成 JSON 的 diff |
| `assets/` | ❌ | 构建产物：`res/` 的压缩包解压出来的（本仓库约 890 MB），`node tools/build-client.mjs` 随时重建 |
| `res/` | ⚠️ 默认提交 | 它是**源素材**，但单个包可能很大（`fat-fish.7z` 428 MB），而 GitHub 单文件上限 100 MB —— 要推远端就取消 `.gitignore` 里 `/res/` 那行（或改用 Git LFS） |

全新克隆后的流程：把桌宠包放进 `res/` → `node tools/build-client.mjs`（或让
`config.buildOnStart: true` 在 dsh 启动时自动做）→ 刷新页面。

`.gitattributes` 里把 `*.7z/*.zip/*.gif…` 标成 binary、文本统一 LF，并把
`lib/client.js` 标成 `linguist-generated`（diff/语言统计里不显示）。

## 卸载

```powershell
dsh plugin remove dsh-fish-pet
```

或在 GUI 的插件设置里把 `dsh-fish-pet` 这个 bundle 关掉。
