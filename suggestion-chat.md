
我想写一个 mcp 可以收集 android 手机或者模拟器的日志一类的东西方便提供给 agent 进行分析 debug ，你有什么建议吗，我们尽量专注在应用层功能的 debug，性能分析和 anr 应该另起一个?



我会把范围先压到“应用层调试 MCP”：日志采集、崩溃/异常、网络线索、设备状态、复现会话打包；不把 Perfetto、CPU/memory profiling、ANR trace 深挖混进来。

核心判断：MCP 不应该直接“吐一屏 logcat 给 agent”。它应该暴露可查询、可裁剪、可打包的调试会话，否则 token 和噪音都会失控。

Thought for 1m 38s
我的建议很明确：先做一个 deterministic 的 android-debug-session CLI/daemon，再包一层 MCP。不要把 adb 逻辑直接写死在 MCP tools 里。

MCP 的价值是把“能力”标准化暴露给 agent：工具、资源、prompt、上下文；协议本身是 JSON-RPC，Server 提供 context/tools，Host/Client 负责调用。
 但 Android 调试这类东西，本质上是一个会话采集系统，MCP 只应该是 agent 入口，不应该是核心执行层。

1. 边界先定死：只做应用层 Debug
应该做
重点收集这些：

logcat

main

system

crash

app PID / package 相关日志

AndroidRuntime

ActivityManager

WindowManager

System.err

自定义业务 tag

Android 官方文档里，logcat 本来就是 dump 系统消息和 app Log 输出的工具；Android logging 由 logd 维护多个 circular buffers，其中 main 放大多数应用日志，system 放系统日志，crash 放崩溃日志。

崩溃上下文

Java/Kotlin uncaught exception

native crash 入口线索

crash 前后 N 行日志，比如你之前偏好的“崩溃前后各 200 行”

app version、build type、git sha、device、ABI、API level

应用状态快照

当前 foreground activity

当前进程 PID

app 是否安装

app versionCode/versionName

granted permissions

process exit reason

ApplicationExitInfo 可以拿到进程死亡原因，例如 Java crash、native crash、ANR、low memory kill、SIGKILL、user requested 等，API 30 起可用。这个对“app 怎么没了”很有价值，但它不是性能分析工具。

复现会话证据

run metadata

commands

logcat raw

parsed JSONL

crash snippet

screenshot 可选

UI tree 可选，比 screenshot 更适合 agent 分析

reproduce steps 手工/自动记录

暂时不要做
这些另起项目：

Perfetto

simpleperf

heap dump

method tracing

frame jank analysis

ANR trace 深挖

battery/network performance profiling

原因：这些东西的数据结构、采集权限、分析模型完全不同。混在一起会把 v1 做烂。你现在要的是应用层 debug evidence collector，不是 Android Studio Profiler 替代品。

2. 推荐架构
不要做成：

Agent -> MCP -> adb logcat -> giant text
这会直接失败：日志太大、噪音太多、上下文不可复用、agent 每次都重新理解。

应该做成：

Agent
  -> MCP facade
    -> android-debug-session core
      -> adb / app helper / file store
        -> .android-debug-runs/{package}/{runId}/...
核心思想：

采集层负责事实
MCP 层负责查询接口
Agent 负责判断
也就是：

CLI/daemon：稳定、可测试、可复用

MCP：暴露工具和资源

Agent：拿 summary、snippet、structured logs 来分析

这符合你之前一直认可的 axis：Tool 做 deterministic execution / data collection，Skill/Agent 做 judgement。

3. 文件结构建议
建议每次 debug 都是一个独立 run：

.android-debug-runs/
  com.example.app/
    2026-05-15T01-42-10Z_ab12cd/
      metadata.json
      commands.jsonl
      events.jsonl
      logcat.raw.txt
      logcat.jsonl
      crash.jsonl
      app-state.json
      summary.md
      artifacts/
        screenshot-start.png
        ui-start.xml
        screenshot-crash.png
        bundle.zip
metadata.json
{
  "schemaVersion": 1,
  "runId": "2026-05-15T01-42-10Z_ab12cd",
  "packageName": "com.example.app",
  "deviceSerial": "emulator-5554",
  "startedAt": "2026-05-15T01:42:10.123Z",
  "git": {
    "branch": "feature/login",
    "commit": "abc1234",
    "dirty": true
  },
  "app": {
    "variant": "debug",
    "versionName": "1.2.3",
    "versionCode": 123
  },
  "device": {
    "apiLevel": 35,
    "model": "Pixel 9",
    "abi": "arm64-v8a"
  }
}
logcat.jsonl
每一行一条 log：

{
  "schemaVersion": 1,
  "ts": "2026-05-15T01:42:12.331Z",
  "deviceSerial": "emulator-5554",
  "buffer": "main",
  "pid": 12345,
  "tid": 12367,
  "priority": "E",
  "tag": "AndroidRuntime",
  "message": "FATAL EXCEPTION: main",
  "raw": "05-15 01:42:12.331 12345 12367 E AndroidRuntime: FATAL EXCEPTION: main"
}
保留 raw 很重要。parser 有 bug 时可以回退，不会损失事实。

4. logcat 采集策略
基础命令可以从这个开始：

adb -s "$SERIAL" logcat \
  -b main,system,crash \
  -v threadtime \
  "*:V"
Android 官方文档说明 -v threadtime 会输出日期、调用时间、priority、tag、PID、TID；-b 可以选择不同 buffer，例如 main、system、crash，也可以用逗号组合。

但是生产级 collector 不应该只靠一个过滤器。

推荐双通道采集
Channel A：完整 raw log
保留完整 run 内日志：

logcat.raw.txt
这用于回溯，不直接喂给 agent。

Channel B：结构化过滤日志
写入：

logcat.jsonl
crash.jsonl
summary.md
agent 默认只读这些。

过滤规则：

include:
  - current app pid
  - previous app pid
  - AndroidRuntime
  - ActivityManager
  - WindowManager
  - System.err
  - libc
  - DEBUG
  - App-specific tags

highlight:
  - FATAL EXCEPTION
  - Caused by:
  - Exception
  - Error
  - ANR in
  - Force finishing activity
  - Process .* has died
  - signal 11
  - SIGSEGV
不建议强依赖 --pid
--pid 看起来干净，但 app crash/restart 后 PID 会变。你如果只跟一个 PID，很容易漏掉：

app 启动前的 ActivityManager 日志

crash 后的 system/crash buffer

进程重启后的日志

更稳的做法：

1. 启动 full stream
2. 定期/事件触发刷新 pidof package
3. parser 里标记 appPidMatched
4. 同时保留关键 system tags
5. MCP tools 设计
MCP 不要暴露太多低级 adb 命令。tool 太多，agent 选择成本会上升。

建议 v1 暴露这些：

android_list_devices
android_start_debug_session
android_stop_debug_session
android_launch_app
android_restart_app
android_mark_event
android_get_app_state
android_read_recent_logs
android_search_logs
android_extract_crash_context
android_collect_debug_bundle
android_list_debug_runs
android_get_run_summary
示例 tool 语义
android_start_debug_session
输入：

{
  "packageName": "com.example.app",
  "deviceSerial": "emulator-5554",
  "clearLocalRunLogs": true,
  "clearDeviceLogcat": false,
  "installMode": "none",
  "captureUiOnStart": true
}
注意这里：

clearLocalRunLogs 默认 true

clearDeviceLogcat 默认 false

installMode 默认 none 或 overwrite

uninstall 必须是显式选项，不要默认做

你之前已经指出过：调试周期开始时主要是清理本地落盘日志；adb uninstall package 不是必须，默认覆盖安装即可。这个判断是对的。

android_extract_crash_context
输入：

{
  "runId": "2026-05-15T01-42-10Z_ab12cd",
  "beforeLines": 200,
  "afterLines": 200
}
输出：

{
  "found": true,
  "type": "java_crash",
  "mainException": "java.lang.IllegalStateException",
  "topFrame": "com.example.LoginViewModel.submit(LoginViewModel.kt:88)",
  "snippetResource": "debug://runs/2026-05-15T01-42-10Z_ab12cd/crash-snippet",
  "summaryResource": "debug://runs/2026-05-15T01-42-10Z_ab12cd/summary"
}
6. MCP resources 设计
资源比 tool 更适合给 agent 读上下文。

debug://runs
debug://runs/{runId}/metadata
debug://runs/{runId}/summary
debug://runs/{runId}/crash
debug://runs/{runId}/logs/recent?level=E&limit=200
debug://runs/{runId}/logs/search?q=AndroidRuntime
debug://runs/{runId}/app-state
debug://runs/{runId}/bundle
默认 resource 要小。不要默认返回几 MB log。

建议分层：

summary.md          默认给 agent
crash.jsonl         需要崩溃时读
logcat.jsonl        搜索后读局部
logcat.raw.txt      只用于人工或 bundle
7. 需要一个小型 app-side debug helper
纯 adb 能做很多，但不是全部。

建议 debug build 里加一个可选 debug-observer 模块，只在 debugImplementation 使用。

它负责：

写结构化业务日志

暴露 ApplicationExitInfo

输出当前登录态摘要，但必须脱敏

输出当前 feature/screen/state summary

捕获 uncaught exception 前的 app 内部 context

可选：OkHttp event/request id 关联

不要把它做成“大而全 SDK”。它只服务本地 debug。

Kotlin 侧结构化日志示例
object DebugEventLogger {
    private const val TAG = "AppDebugEvent"

    fun screen(name: String, state: Map<String, Any?> = emptyMap()) {
        Log.i(TAG, encode(
            type = "screen",
            payload = mapOf(
                "name" to name,
                "state" to state.sanitize()
            )
        ))
    }

    fun action(name: String, payload: Map<String, Any?> = emptyMap()) {
        Log.i(TAG, encode(
            type = "action",
            payload = mapOf(
                "name" to name,
                "payload" to payload.sanitize()
            )
        ))
    }

    fun error(
        name: String,
        throwable: Throwable,
        payload: Map<String, Any?> = emptyMap()
    ) {
        Log.e(TAG, encode(
            type = "error",
            payload = mapOf(
                "name" to name,
                "message" to throwable.message,
                "payload" to payload.sanitize()
            )
        ), throwable)
    }

    private fun encode(type: String, payload: Map<String, Any?>): String {
        return JSONObject(
            mapOf(
                "schemaVersion" to 1,
                "type" to type,
                "payload" to payload
            )
        ).toString()
    }

    private fun Map<String, Any?>.sanitize(): Map<String, Any?> {
        val sensitiveKeys = setOf("token", "authorization", "password", "cookie")
        return mapValues { (key, value) ->
            if (key.lowercase() in sensitiveKeys) "***" else value
        }
    }
}
这比让 agent 从普通中文/英文日志里猜强很多。

核心数据结构是 append-only event stream。复杂度上，写入是 O(1) append，查询可以先线性 O(n)，后续再加 tag/time index。v1 不需要 SQLite，JSONL 足够。

8. TypeScript/Bun 技术栈
你现在这个项目适合：

Bun
TypeScript
@modelcontextprotocol/server 或官方 TypeScript SDK
Zod
execa / Bun.spawn
proper-lockfile 或自写 lockfile
JSONL append-only store
Vitest
tsup
官方 TypeScript SDK 现在支持创建 MCP server，暴露 tools/resources/prompts，并支持本地和远程 transport；它也支持 Node、Bun、Deno 运行时。

v1 推荐 stdio MCP，因为本地 agent 调试最简单。后面如果要多 agent、多端共享，再加 Streamable HTTP。

9. Collector 内部模块拆分
src/
  cli/
    index.ts
    commands/
      start.ts
      stop.ts
      launch.ts
      bundle.ts

  mcp/
    server.ts
    tools/
      startDebugSession.ts
      readRecentLogs.ts
      extractCrashContext.ts
    resources/
      runSummary.ts
      crashSnippet.ts

  android/
    adb.ts
    devices.ts
    packageInfo.ts
    appState.ts
    logcatProcess.ts

  logcat/
    parser.ts
    classifier.ts
    crashExtractor.ts
    filters.ts

  store/
    runStore.ts
    jsonl.ts
    lock.ts
    paths.ts

  domain/
    DebugRun.ts
    LogEntry.ts
    CrashContext.ts
    AppState.ts
关键点：mcp/ 不应该知道 adb 细节。它只调用 use case。

10. 最小 CLI 命令设计
android-debug-session devices

android-debug-session start \
  --package com.example.app \
  --serial emulator-5554 \
  --clear-local \
  --no-clear-logcat

android-debug-session launch \
  --run-id 2026-05-15T01-42-10Z_ab12cd

android-debug-session mark \
  --run-id 2026-05-15T01-42-10Z_ab12cd \
  --name "clicked login"

android-debug-session crash \
  --run-id 2026-05-15T01-42-10Z_ab12cd \
  --before 200 \
  --after 200

android-debug-session summary \
  --run-id 2026-05-15T01-42-10Z_ab12cd

android-debug-session bundle \
  --run-id 2026-05-15T01-42-10Z_ab12cd
MCP tools 只是这些命令的类型安全 wrapper。

11. Agent 默认工作流
给 agent 的 prompt 可以固定成：

1. Start debug session.
2. Launch or restart app.
3. Ask user to reproduce, or run supplied adb/ui steps.
4. Mark key steps.
5. Stop session.
6. Extract crash context.
7. Read summary first.
8. Search logs only if summary is insufficient.
9. Produce root cause hypothesis, evidence, confidence, and next verification step.
agent 不应该第一步就读 full log。

12. 你最容易踩的坑
坑 1：日志太多
解决：

raw 全保留
agent 只看 summary/snippet/search result
坑 2：PID 变化导致漏日志
解决：

不要只靠 --pid
维护 pid timeline
保留 system/crash 关键 tag
坑 3：清理 logcat 影响其他任务
adb logcat -c 是设备级清理，不是你的 run 私有空间。建议默认只清理本地 .android-debug-runs 下的 run 目录。需要干净设备 buffer 时再显式传 --clear-device-logcat。

坑 4：MCP 暴露 shell passthrough
不要做：

android_shell(command: string)
这等于给 agent 本地 RCE。

只暴露白名单工具：

launch_app
stop_app
read_logs
search_logs
collect_bundle
坑 5：敏感信息泄漏
必须默认脱敏：

Authorization
Cookie
Set-Cookie
token
refreshToken
password
email
phone
lat/lng
deviceId
尤其你以后如果让 agent 自动上传 bundle 给 Claude/Codex/Gemini，脱敏不是可选项。

13. v1 / v2 / v3 路线
v1：应用层日志会话
必须有：

devices
start/stop session
logcat raw + jsonl
crash extraction
summary
bundle
MCP tools/resources
v2：UI context
加入：

screenshot
uiautomator dump
current activity
screen description
step markers
这和你之前偏好的 layout + screenshot + resolve + describe 是同一条线。

v3：app-side debug helper
加入：

ApplicationExitInfo
structured app events
network request correlation
screen state summary
debug-only broadcast/content provider
另起项目：performance/anr
单独做：

android-perf-session
android-anr-session
不要塞进这个 MCP。

14. 最终推荐
项目定位可以叫：

android-debug-mcp
但内部核心应该叫：

android-debug-session
一句话设计：

A local Android application-layer debug session collector that records adb/logcat/app-state evidence into structured JSONL artifacts, then exposes small searchable summaries and bundles to agents through MCP.
这比“一个 MCP 收集 Android 日志”更准确。后者会自然滑向 adb wrapper；前者是可维护的调试证据系统。

What questions should I have asked?

这个工具优先服务“崩溃定位”，还是“业务流程异常但不崩溃”的定位？两者的默认 summary 和过滤规则不同。

是否愿意在 debug build 里接入一个轻量 debug-observer 模块？如果愿意，诊断能力会比纯 adb 强一个量级。


你的补充把优先级改了：最有价值的不是“再多收集一点设备信息”，而是建立 tap → UI node → semantic identity → source/code owner 这条链。这个应当成为 v2 核心。

Thought for 2m 8s
对，“点击哪个元素 → 定位到代码位置” 比单纯多收集 log 更有 debug 价值。这里要拆清楚：

Android Studio 的 Layout Inspector、UIAutomator、Accessibility、adb shell、App 内 instrumentation，很多都能拿到“屏幕上的 UI 节点”；但只有一部分能稳定映射回“代码位置”。

1. “信息来源”不是“工具名”
我前面那句话的意思是：

Android Studio
  不是一个单一信息源
  它只是把很多底层信息聚合成 IDE 能理解的 UI
例如 Layout Inspector 能看到：

View / Compose hierarchy

属性、尺寸、bounds

运行时 layout 状态

Compose recomposition / skip counts

Compose semantics

双击某些 View/Composable 跳到代码

这些能力在 Android Studio 里很好用。官方文档明确说 Layout Inspector 可以显示运行时 view hierarchy 和属性，并且开启 Deep Inspect 后可以点击 view、双击 view 导航到代码；也能导出 layout hierarchy snapshot。

但问题是：Android Studio 能做到，不等于你自己的 MCP 可以稳定调用同一套内部能力。

Layout Inspector 的 IDE 集成能力很强，但它不是一个面向第三方 MCP 的稳定 public CLI/API。你可以借鉴它的模型，但 v1 不应该强依赖“复刻 Android Studio Layout Inspector 协议”。

2. 能拿到哪些“非 logcat”信息？
A. UI hierarchy：最应该做
有三条路：

1. UIAutomator dump / UIAutomator API
2. AccessibilityService
3. Android Studio Layout Inspector / snapshot
UIAutomator 的优势是它可以从 app 进程外测试 app，能查找 UI 元素、执行点击、等待元素出现，并且能访问 accessibility window nodes；官方文档也强调它适合跨 app / release app / macrobenchmark 场景。

UI hierarchy 一般能拿到：

{
  "className": "android.widget.Button",
  "resourceId": "com.example:id/login_button",
  "text": "Login",
  "contentDescription": null,
  "bounds": "[48,720][1032,816]",
  "clickable": true,
  "enabled": true,
  "focused": false,
  "selected": false
}
这已经足够让 agent 说：

用户点的是 com.example:id/login_button
它位于 LoginActivity / LoginFragment 当前屏幕
点击后出现 IllegalStateException
B. Compose semantics：Compose 场景必须做
Compose 不天然等价于 View tree。你需要依赖 semantics。

Compose 官方定义 semantics 是给 accessibility、autofill、testing 这类服务理解 UI 语义的额外上下文。
 Android Studio Layout Inspector 也可以检查 Compose semantics，并且能显示 recomposition/skip counts；双击 composable 还能跳到对应代码分析。

所以 Compose 下，最佳实践不是只看文本和 bounds，而是强制你们写：

Modifier.semantics {
    testTag = "login.submit_button"
    contentDescription = "Submit login"
}
或者：

Modifier.testTag("login.submit_button")
然后 MCP 里把点击节点识别成：

{
  "uiType": "compose",
  "semanticId": "login.submit_button",
  "text": "Login",
  "bounds": [48, 720, 1032, 816],
  "screen": "LoginScreen"
}
C. 当前 Activity / Fragment / screen state
这类信息可以从多处拿：

adb shell dumpsys activity
app-side debug helper
日志埋点
FragmentLifecycleCallbacks
Navigation back stack
Compose route state
但是最可靠的是 app 内 debug-observer 主动上报，例如：

{
  "screen": "LoginScreen",
  "activity": "MainActivity",
  "fragment": "LoginFragment",
  "navRoute": "login",
  "uiState": {
    "loading": false,
    "emailValid": true,
    "submitEnabled": true
  }
}
裸 adb 很难知道你的 MVI state。这个必须 app 内提供。

D. Crashlytics / Android Vitals / IDE crash data
Android Studio 的 App Quality Insights 能把 Crashlytics 和 Android Vitals 数据拉进 IDE，并支持从 stack trace 跳到代码。

这个适合“线上问题回放”，不适合本地单次交互 debug 的主路径。可以放 v3。

3. “点击元素 → 代码位置”怎么设计？
这里要现实一点：点击坐标本身不能直接定位代码。

点击坐标只能告诉你：

x=520, y=762
下一步必须映射：

坐标 -> UI node -> 稳定 ID -> 源码位置
推荐链路：

Tap event
  -> nearest UI node by bounds
    -> resource-id / testTag / semantics
      -> screen owner
        -> source index
          -> Kotlin/XML/Compose code location
XML/View 场景
如果点到的是：

com.example:id/login_button
那可以定位到：

res/layout/fragment_login.xml
<Button
    android:id="@+id/login_button" />
然后进一步定位 Kotlin 代码：

binding.loginButton.setOnClickListener { ... }
或者：

findViewById<Button>(R.id.login_button)
这个可以通过代码索引搜索完成。

MCP 不一定自己做 AST parser，先用 ripgrep 就够：

rg "login_button|R.id.login_button|binding.loginButton"
更高级可以接 JetBrains IDE 索引，但 v1 先别依赖。

Compose 场景
Compose 没有天然 R.id.xxx。所以你必须自己引入稳定标识：

Button(
    modifier = Modifier
        .testTag("login.submit_button")
        .debugSource("LoginScreen.kt", "LoginSubmitButton"),
    onClick = onSubmit
) {
    Text("Login")
}
然后 MCP 采集到：

{
  "semanticId": "login.submit_button",
  "sourceHint": {
    "file": "LoginScreen.kt",
    "symbol": "LoginSubmitButton"
  }
}
再用代码索引定位。

如果不加 testTag / semantics / debugSource，agent 只能猜：

点的是文本为 Login 的 Button
可能在 LoginScreen.kt
这不够生产级。

4. 最推荐方案：三层定位
第 1 层：无侵入，靠 UI hierarchy
适合快速开始。

数据来源：
- UIAutomator dump
- screenshot
- bounds
- resource-id
- text
- content-desc
能回答：

用户点击了哪个可见控件
控件在屏幕哪里
控件 id/text/class 是什么
点击前后 UI hierarchy 有什么变化
缺点：

不能稳定知道 onClick 写在哪
Compose 可能信息不足
RecyclerView item 只能知道 item 文案/位置，不知道 adapter 绑定来源
第 2 层：debug build app helper
这是我最推荐你做的。

在 app debug build 里挂一个 DebugInteractionTracker：

View 系：
- 监听 Window.Callback / dispatchTouchEvent
- 根据坐标递归 hit-test root view
- 记录 clicked View 的 id/class/text/contentDescription/bounds
- 记录 Activity/Fragment/NavRoute
- 可选记录最近 ViewModel state summary

Compose 系：
- 提供 Modifier.debugClickable / Modifier.debugTag
- 每次 click 主动写 DebugEvent
输出：

{
  "type": "ui_click",
  "time": "2026-05-15T01:58:12.123Z",
  "screen": "LoginScreen",
  "node": {
    "kind": "View",
    "resourceId": "com.example:id/login_button",
    "className": "MaterialButton",
    "text": "Login",
    "bounds": [48, 720, 1032, 816]
  },
  "sourceHints": [
    "fragment_login.xml",
    "LoginFragment.kt",
    "LoginViewModel.kt"
  ]
}
第 3 层：源码索引
MCP 端建立一个 local index：

resource-id index:
  login_button -> res/layout/fragment_login.xml
  login_button -> LoginFragment.kt binding.loginButton
  login_button -> LoginViewModel.submit

compose tag index:
  login.submit_button -> LoginScreen.kt
  login.submit_button -> LoginViewModel.submit
v1 可以用 rg，v2 用 Kotlin PSI / JetBrains plugin / LSP。

5. 具体 MCP tools 设计应该加这些
你原来的日志 MCP 可以扩成：

android_capture_ui_snapshot
android_get_current_screen
android_record_next_tap
android_get_last_interaction
android_find_ui_node_at
android_map_ui_node_to_source
android_compare_ui_before_after
android_record_next_tap
用途：用户真实点击一次，MCP 返回点到的元素。

{
  "packageName": "com.example.app",
  "timeoutMs": 15000,
  "includeScreenshot": true,
  "includeHierarchy": true
}
输出：

{
  "tap": {
    "x": 520,
    "y": 762,
    "time": "2026-05-15T01:58:12.123Z"
  },
  "node": {
    "resourceId": "com.example:id/login_button",
    "className": "com.google.android.material.button.MaterialButton",
    "text": "Login",
    "bounds": [48, 720, 1032, 816],
    "clickable": true
  },
  "screen": {
    "activity": "MainActivity",
    "fragment": "LoginFragment",
    "route": "login"
  },
  "sourceCandidates": [
    {
      "file": "app/src/main/res/layout/fragment_login.xml",
      "reason": "declares @+id/login_button"
    },
    {
      "file": "app/src/main/java/.../LoginFragment.kt",
      "reason": "references binding.loginButton"
    }
  ]
}
android_map_ui_node_to_source
输入：

{
  "resourceId": "com.example:id/login_button",
  "semanticId": null,
  "text": "Login",
  "screen": "LoginFragment"
}
输出：

{
  "confidence": 0.87,
  "locations": [
    {
      "file": "app/src/main/res/layout/fragment_login.xml",
      "line": 42,
      "kind": "xml_declaration"
    },
    {
      "file": "app/src/main/java/.../LoginFragment.kt",
      "line": 88,
      "kind": "click_listener"
    },
    {
      "file": "app/src/main/java/.../LoginViewModel.kt",
      "line": 120,
      "kind": "business_action"
    }
  ]
}
6. View 点击追踪：可行但要注意
可以在 debug build 里做一个 hit-test：

fun findTopMostViewAt(root: View, x: Float, y: Float): View? {
    if (!root.isShown) return null

    val location = IntArray(2)
    root.getLocationOnScreen(location)

    val left = location[0]
    val top = location[1]
    val right = left + root.width
    val bottom = top + root.height

    if (x !in left.toFloat()..right.toFloat() || y !in top.toFloat()..bottom.toFloat()) {
        return null
    }

    if (root is ViewGroup) {
        for (i in root.childCount - 1 downTo 0) {
            val child = root.getChildAt(i)
            val hit = findTopMostViewAt(child, x, y)
            if (hit != null) return hit
        }
    }

    return root
}
然后记录：

fun View.debugIdentity(): Map<String, Any?> {
    val idName = if (id != View.NO_ID) {
        runCatching { resources.getResourceName(id) }.getOrNull()
    } else null

    return mapOf(
        "className" to this::class.java.name,
        "resourceId" to idName,
        "contentDescription" to contentDescription?.toString(),
        "clickable" to isClickable,
        "enabled" to isEnabled,
        "visible" to isShown
    )
}
但是这个只能知道“命中的 View”。真正的业务点击可能在：

parent ViewGroup
RecyclerView item root
ComposeView
自定义 View 内部区域
TouchDelegate 扩展区域
GestureDetector
所以 View hit-test 只能作为证据，不是绝对真相。

7. Compose 点击追踪：不要靠反射，靠显式 debug modifier
不要试图 hack Compose runtime。成本高，稳定性差。

建议你们自己封装：

@Composable
fun DebugButton(
    debugId: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable RowScope.() -> Unit
) {
    Button(
        modifier = modifier
            .testTag(debugId)
            .semantics {
                contentDescription = debugId
            },
        onClick = {
            DebugEventLogger.action(
                name = "compose_click",
                payload = mapOf("debugId" to debugId)
            )
            onClick()
        },
        content = content
    )
}
使用：

DebugButton(
    debugId = "login.submit_button",
    onClick = viewModel::submit
) {
    Text("Login")
}
这比让 agent 从 Compose tree 里猜要稳定得多。

8. 最终建议：你的 MCP 应该升级成 “Interaction Debug MCP”
不要只叫 log MCP。更准确是：

android-interaction-debug-mcp
核心数据模型：

DebugRun
  ├── logs
  ├── uiSnapshots
  ├── interactions
  ├── appState
  ├── crashContext
  └── sourceMappings
每次 debug，不是只保存 log，而是保存：

{
  "interaction": {
    "type": "tap",
    "target": "login.submit_button",
    "sourceCandidates": [
      "LoginScreen.kt",
      "LoginViewModel.kt"
    ]
  },
  "before": {
    "screen": "LoginScreen",
    "uiState": "Idle"
  },
  "after": {
    "screen": "LoginScreen",
    "uiState": "Loading"
  },
  "logs": {
    "errors": [],
    "warnings": ["Login request took 3.2s"]
  }
}
这样 agent 才能真正分析：

用户点了哪个元素
它属于哪个 screen
它触发了哪个 ViewModel action
action 后 UI state 是否变化
是否发了网络请求
是否有错误日志
失败点在哪一层
结论
你要的能力可以做，但不要幻想“点击一下就天然跳到代码”。正确做法是：

UI hierarchy / Accessibility / Layout Inspector 风格信息
  + debug build interaction tracker
  + 稳定 semantic id / resource id
  + 本地源码索引
  = tap -> element -> source candidates
最高 ROI 的版本：

v1:
  UIAutomator dump + screenshot + resource-id/text/bounds + logcat

v2:
  debug build DebugInteractionTracker
  record tap -> View/Compose semantic id
  source mapping by rg/index

v3:
  IDE plugin / JetBrains index
  click target -> exact symbol
  ViewModel action/state correlation
不建议一开始就复刻 Android Studio Layout Inspector。先把 tap → node → id → source candidates → logs around interaction 做扎实，agent 的 debug 质量会立刻提升。


Features

This MCP server provides tools to:

Test Management: Create test folders for organizing automation tests
App Control: List installed apps by name pattern and open apps by package name
Screen Capture: Take screenshots and save them to organized test folders
UI Analysis: Capture UI hierarchy dumps for element inspection
Input Simulation:
Send key events (BACK, HOME, ENTER, DELETE)
Tap at specific coordinates
Input text into active fields
Scroll in any direction (up, down, left, right)


以及看看https://github.com/beyondwin/FixThis

Thought for 1m 16s
结论：你贴的这个 Android-Debug-Bridge-MCP 更像“ADB 自动化工具箱”，适合作为底座，但离你想要的 debug 证据系统 / 点击定位源码 还差一层关键设计。FixThis 的方向更接近你要的东西：它不是只让 agent 点屏幕，而是把“屏幕目标 → 语义证据 → source candidates → agent handoff”串起来。

1. 你贴的这个功能列表：可用，但层级偏低
这个项目是 TiagoDanin/Android-Debug-Bridge-MCP，README 里定义的能力就是：创建测试文件夹、列 app、打开 app、截图、dump UI hierarchy、按键、坐标点击、输入文本、滚动。它依赖 ADB，需要设备开启 USB debugging 或 emulator 运行。

这类工具适合做：

app 自动打开
截图
UI dump
坐标点击
输入文本
滚动
保存测试步骤产物
但它不适合直接解决：

用户点的是哪个业务控件？
这个控件属于哪个 screen？
这个元素由哪个 XML / Composable / Adapter / ViewHolder 渲染？
点击后触发的是哪个 ViewModel action？
失败日志和这次点击有什么因果关系？
所以它是 device actuator + artifact capture，不是 debug intelligence layer。

你可以借它的功能，但不要照着它做最终形态。否则你会写出一个“agent 能控制手机”的 MCP，而不是“agent 能定位 bug”的 MCP。

2. Android Studio / Layout Inspector 能给什么？
Android Studio 的 Layout Inspector 能检查运行中 app 的 View hierarchy、属性、Compose layout、semantics、recomposition/skip counts，还可以导出 layout hierarchy snapshot；Deep Inspect 模式下，单击选择 view，双击可以跳到代码。

Compose 侧，官方文档明确说 Layout Inspector 可以看 recomposition / skip count、Compose semantics，并且 double-click composable 可以跳到对应代码。

但现实问题是：

Android Studio 能做到
≠
你的 MCP 能稳定调用同一套内部 API
Layout Inspector 的能力很强，但主要是 IDE 内部工作流，不是稳定公开给第三方 MCP 的 CLI/API。我的建议是：

不要依赖 Android Studio Layout Inspector 作为 v1 实现
把它当作产品目标参考
自己实现一个更窄、更可控的 evidence pipeline
3. FixThis 值得重点看
FixThis 的定位非常接近你刚才说的能力：Point at any Jetpack Compose UI element, annotate it, and hand off source pinned prompts to AI coding agents。它的问题定义也很准确：只发截图给 agent 会让 agent 猜“第二个卡片右边那个 chip”到底在哪个源码里；FixThis 则会附带 source-file candidates、semantic tree、activity、bounds、severity/status 等结构化上下文。

它和普通 screenshot / accessibility tree 的核心差异有三点：

1. Pin to source, not pixels
2. Stable target identity
3. Screen integrity checks
README 里说它会给 top-3 source-file candidates、line numbers、match reasons、margin score；还会处理视觉上重复的组件实例，以及保存前检查 screen fingerprint，避免你选的屏幕已经变了。

这就是你要的方向。

4. 但 FixThis 的边界也很窄
FixThis v1 明确限制：

Jetpack Compose only
debug builds only
local-only & ADB-only
no required testTags
no AccessibilityService
in-process sidekick
source candidates are best-effort
这些都写在它的 README 里。

它目前还没有发布到 Maven Central / Gradle Plugin Portal，外部项目需要通过 Gradle composite build 或 project dependency 接入；它要求 JDK 21、AGP 9.1.1、Kotlin 2.2.21、Compose BOM 2026.04.01、minSdk 24。

所以判断很清楚：

FixThis 是很好的参考实现 / 方向验证
但不适合作为你整个 Android debug MCP 的完整答案
尤其你很多项目仍然是 XML/View，不是纯 Compose。FixThis v1 对 View-based hierarchy、XML、AndroidView interop、WebView 都不是主要目标。

5. 最优架构：不要三选一，要分层组合
我建议你拆成三层：

Layer 1: ADB Automation Provider
Layer 2: App-side Debug Bridge / Sidekick
Layer 3: Source Mapping + Agent Handoff
Layer 1：ADB Automation Provider
这层可以参考 Android-Debug-Bridge-MCP 或 CursorTouch/Android-MCP。

CursorTouch/Android-MCP 这类项目也提供 ADB + Android Accessibility API 的 UI interaction，包括 launch、tap、swipe、input text、read view hierarchy、device state、shell command 等。

你需要的基础 tools：

android_list_devices
android_list_apps
android_launch_app
android_restart_app
android_capture_screenshot
android_capture_ui_dump
android_tap
android_input_text
android_key_event
android_scroll
这层只负责“设备操作”和“低级证据采集”。

Layer 2：App-side Debug Bridge
这层才是关键。参考 FixThis 的 sidekick 思路：debug app 内部暴露一个本地 bridge，桌面端通过 ADB forward 连进去。FixThis 的文档里架构就是：MCP client → fixthis mcp over stdio → ADB forward → localabstract socket → debug app sidekick。

你自己的版本可以叫：

android-debug-sidekick
只在 debugImplementation 接入：

debugImplementation(project(":android-debug-sidekick"))
它负责：

当前 Activity
当前 Fragment / Nav route
当前 screen name
最近点击事件
ViewModel state summary
Compose semantics summary
View tree hit-test result
app version / git sha / build variant
ApplicationExitInfo
业务事件流
这层解决裸 ADB 不知道业务语义的问题。

Layer 3：Source Mapping + Agent Handoff
这层负责：

resourceId -> XML file
resourceId -> binding reference
testTag / semanticId -> Composable file
screen route -> screen owner file
click event -> ViewModel action
source candidates -> confidence / margin / warning
FixThis 已经有类似思路：MCP tools 里有 fixthis_read_feedback、fixthis_claim_feedback、fixthis_resolve_feedback，并且 SourceCandidate 会带 ranking、scoreMargin、evidenceStrength 等字段。

你应该借这个队列模型：

human/agent 发现一个 UI 问题
保存为 feedback item
agent claim item
agent 修改代码
agent resolve item
这比“发一张截图让 agent 修”严谨很多。

6. 你的 MCP 最小工具集应该这样设计
不要只做 Android-Debug-Bridge-MCP 那种 9 个工具。建议 v1 就这样分组。

A. Device / App
android_list_devices
android_select_device
android_list_apps
android_launch_app
android_restart_app
android_get_app_state
B. Evidence Capture
android_start_debug_run
android_stop_debug_run
android_capture_screenshot
android_capture_ui_tree
android_capture_logs
android_extract_crash_context
android_collect_debug_bundle
C. Interaction
android_tap
android_input_text
android_key_event
android_scroll
android_record_next_tap
android_get_last_interaction
D. Source Mapping
android_find_ui_node_at
android_map_ui_node_to_source
android_search_source_candidates
android_get_current_screen_source
E. Feedback / Handoff
android_create_feedback_item
android_list_feedback
android_read_feedback
android_claim_feedback
android_resolve_feedback
这才是完整闭环。

7. 点击定位源码的真正数据模型
你最终要生成的不是普通 UI dump，而是这种结构：

{
  "interactionId": "tap_2026_05_15_012300_001",
  "type": "tap",
  "tap": {
    "x": 512,
    "y": 744,
    "coordinateSpace": "window"
  },
  "screen": {
    "activity": "com.example.MainActivity",
    "fragment": "LoginFragment",
    "route": "login"
  },
  "target": {
    "kind": "view",
    "resourceId": "com.example:id/login_button",
    "className": "com.google.android.material.button.MaterialButton",
    "text": "Login",
    "contentDescription": null,
    "bounds": [48, 700, 1032, 812],
    "clickable": true,
    "confidence": "high"
  },
  "sourceCandidates": [
    {
      "file": "app/src/main/res/layout/fragment_login.xml",
      "line": 42,
      "kind": "xml_declaration",
      "reason": "Declares @+id/login_button",
      "confidence": "high"
    },
    {
      "file": "app/src/main/java/com/example/LoginFragment.kt",
      "line": 88,
      "kind": "click_listener",
      "reason": "References binding.loginButton",
      "confidence": "medium"
    },
    {
      "file": "app/src/main/java/com/example/LoginViewModel.kt",
      "line": 121,
      "kind": "business_action",
      "reason": "submit() is called from login button click path",
      "confidence": "medium"
    }
  ],
  "logsAroundInteraction": {
    "beforeMs": 2000,
    "afterMs": 5000,
    "errors": [],
    "warnings": []
  }
}
这个结构比单纯：

<node text="Login" bounds="[48,700][1032,812]" />
有价值得多。

8. XML/View 和 Compose 要走不同路径
XML/View
优先级：

resource-id
binding reference
Fragment / Activity owner
RecyclerView adapter / ViewHolder
click listener / debounced click wrapper
ViewModel action
最现实的 source mapping：

R.id.login_button
binding.loginButton
@+id/login_button
setOnClickListener
先用 rg 就够：

rg "login_button|R.id.login_button|binding.loginButton"
后面再接 JetBrains MCP / LSP / Kotlin PSI。

Compose
不要只依赖文本。必须建立稳定语义 ID。

建议强制项目规范：

Button(
    modifier = Modifier
        .testTag("login.submit_button")
        .semantics {
            contentDescription = "login.submit_button"
        },
    onClick = onSubmit
) {
    Text("Login")
}
更进一步，你可以封装：

@Composable
fun DebugTrackedButton(
    debugId: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable RowScope.() -> Unit
) {
    Button(
        modifier = modifier
            .testTag(debugId)
            .semantics {
                contentDescription = debugId
            },
        onClick = {
            DebugEventLogger.logClick(debugId)
            onClick()
        },
        content = content
    )
}
FixThis 的路线是“不强制 testTags”，靠 semantics + nearby labels + composable-name conventions 做智能选择。
 但我对你自己的项目建议更强硬：debugId/testTag 应该成为复杂业务 UI 的工程规范。不然 agent 定位会长期不稳定。

9. 对 FixThis 的取舍建议
借鉴
你应该借这些：

debugImplementation sidekick
local-only
ADB forward 到 app 内 bridge
browser feedback console
frozen screenshot
annotation batch
source candidates
confidence / margin score
screen fingerprint
claim / resolve workflow
install stale check
尤其 installStale 很关键：FixThis 会检查源码是否比设备 APK 的安装时间更新，避免 agent 根据旧 APK 返回的 source coordinates 去改新代码。

不要照搬
不要照搬这些限制：

Compose only
只做人工 annotation
只做 UI 修复 handoff
不接 logcat / crash context
不覆盖 XML/View
不覆盖 RecyclerView adapter binding path
你的目标比 FixThis 更偏 debug，所以要把它扩成：

FixThis-style source-pinned UI evidence
+
debug session logs
+
crash context
+
app state
+
interaction timeline
10. 我建议你的项目定位
不要叫单纯的：

android-adb-mcp
这太低级。

建议叫：

android-debug-context-mcp
或者：

android-interaction-debug-mcp
一句话定义：

一个本地 Android 应用层 debug MCP：采集截图、UI tree、点击目标、日志、崩溃、app state，并把用户交互映射到 source candidates，交给 agent 做定位和修复。
11. MVP 顺序
Phase 1：先复制 ADB MCP 的底座
list devices
launch app
screenshot
ui dump
tap/input/scroll/key
logcat capture
debug run folder
这部分 2–3 天可以做出有用版本。

Phase 2：加 tap → node
record tap
capture before/after screenshot
capture UI hierarchy
坐标 hit-test
返回 target node
保存 interaction.jsonl
这一步会立刻提升 agent debug 能力。

Phase 3：加 node → source candidates
View/XML:
  resourceId -> XML
  resourceId -> binding usage
  Fragment/Activity owner

Compose:
  testTag / semanticId -> Composable
  screen route -> Screen function
先用 rg，不要一开始搞复杂 AST。

Phase 4：加 debug sidekick
debugImplementation
current screen state
recent interactions
ViewModel action log
ApplicationExitInfo
structured app events
这一步是质变。

Phase 5：加 FixThis-style console
浏览器打开当前屏幕
点击/框选目标
写 comment
保存为 MCP handoff
agent claim/resolve
这一步做完，你的工具就不是普通 Android MCP 了。

最终判断
你的方向应该是：

Android-Debug-Bridge-MCP 的 ADB 基础能力
+
FixThis 的 source-pinned annotation / handoff 思路
+
你自己的 app-layer debug session / logs / crash context
不要只做“控制手机”。控制手机是低价值底座。真正有价值的是：

这次用户点了什么
它在业务上是什么
它由哪段源码渲染
它触发了什么状态变化
失败证据在哪
agent 应该从哪个文件开始修
What questions should I have asked?

你的主项目当前 XML/View 和 Compose 的比例是多少？这会决定 source mapping 的第一优先级。

你希望 agent 是“自动操作手机复现”，还是“你手动点、agent 读取证据分析”？这两个模式的 MCP tool 设计不同。


https://github.com/Atul206/androidclaudio 看看这个

我会重点看它是否只是 ADB 控制层，还是已经有“UI 语义/源码定位/调试会话”这些更高层能力；然后和你前面提到的 FixThis、ADB MCP 做对比。

Thought for 2m 28s
看完了。androidclaudio 的方向不是“ADB 控制手机”，而是“把 debug APK 变成一个可被 agent 调用的运行中业务对象服务器”。 它有启发价值，但我不建议照搬；更适合作为你工具里的 App-side business bridge 子模块。

1. 它在做什么
androidclaudio 的 README 说法是：把 MCP server 嵌进 debug APK，让 Claude/Codex/Cursor Code 获得运行中 Android app 的 live knowledge；它通过 KSP 根据 groups.json 生成 registry，然后在 Application.onCreate 里启动 server，借助 adb forward tcp:5173 tcp:5173 让桌面 agent 调用运行中 app 的函数。

它的组件大概是：

androplaudio-setup CLI
  -> 扫描项目，生成 androplaudio-groups.json

androplaudio-ksp
  -> 读取 groups.json
  -> 生成 GeneratedGroupRegistry

androplaudio-core
  -> debugImplementation 接入 APK
  -> Application 初始化
  -> 启动 Ktor HTTP server
  -> 暴露 /tools/list 和 /tools/call
README 里也明确写了 debugImplementation(files("libs/androplaudio-core-1.0.0.aar"))，并声称 release build 完全不包含它；入口是 if (BuildConfig.DEBUG) AndroClaudio.initialize(this)。

2. 它和前面几个项目的区别
项目类型	能力中心	适合解决	不适合解决
ADB MCP	设备操作	截图、UI dump、tap、输入、滚动、logcat	业务语义、源码定位
FixThis	UI 元素 → source candidates	Compose UI 问题标注、源码候选定位	通用业务对象调用、XML/View 全覆盖
androidclaudio	运行中业务对象调用	直接调用 Repository/UseCase/Manager，验证业务链路	点击元素定位、UI hierarchy、log/crash evidence
androidclaudio 本质上更像一个“debug-only RPC bridge”。 它让 agent 不读源码也能发现某些业务类和 public functions，然后直接调用这些函数。README 举例是 agent 调用 cart.manager.addItem()，真实实例里的 StateFlow 触发 ViewModel 收集，最终 UI 更新。

这和你想要的“点击哪个元素 → 定位代码”不是同一类问题，但可以互补。

3. 我对它的关键判断：概念好，工程实现偏危险
优点
第一，它的分层思路是对的。agent 不应该只会点屏幕，也应该能询问/调用 app 内部业务状态。 比如：

agent:
  当前购物车状态是什么？
  当前用户是否登录？
  当前 feature flag 是什么？
  mock 模式下调用 usecase 会返回什么？
  live 模式下调用 repository 是否真的失败？
这比只看 logcat 强。

第二，KSP 生成 registry 的思路比运行时乱反射更好。它在 KSP 里读取 groups.json，对指定 class 生成 tools metadata 和 call(fn, args, instance) 分发逻辑。

第三，debug-only 接入方向正确。对这种能力，必须默认只在 debug 变体存在。README 和代码都把接入点放在 debug runtime：debugImplementation + BuildConfig.DEBUG。

问题
最大问题：它现在不是真正标准 MCP server，更像自定义 HTTP RPC。

官方 MCP 规范使用 JSON-RPC 2.0 消息进行 Host、Client、Server 通信。
 但这个项目代码里是 Ktor HTTP server，暴露的是：

GET  /
GET  /tools/list
GET  /tools/list?group=<id>
POST /tools/call
这些路由在 MCPServer.android.kt 里是硬编码的 REST-ish endpoint，不是标准 MCP tools/list / tools/call JSON-RPC session。

所以它可能能被某些 agent 通过自定义 skill/adapter 调用，但不能直接等价于“标准 MCP server”。

第二个问题：安全面太大。 它允许通过 HTTP 调用 app 内 public business functions。虽然它通过 KSP 过滤掉 lifecycle、ContentProvider、equals/hashCode/toString/copy 等方法，但仍然会暴露 public 方法；KSP 的 isEffectivelyPublic() 甚至把 internal 也视为可暴露。

这在 debug build 里不是不能做，但必须有更强的 allowlist，而不是“扫描后默认很多 public method 都可调用”。

第三个问题：DI resolution 太乐观。 它对 Koin 通过 GlobalContext.get() 反射解析；Hilt/Dagger 需要手动 registerInstance()；如果都不行，还会尝试无参构造器创建实例。

这会产生一个很危险的假象：

agent 以为调用的是 app 正在使用的真实对象
实际可能是新建出来的空对象
对 debug 来说，这种“假 live state”比没有信息更危险。

第四个问题：它的调用分发还很粗糙。KSP 生成代码里通过 args["param"] as Int/String/... 做类型转换；复杂 data class、泛型、nullable、默认参数、overload、sealed result、suspend error propagation 都会很快出问题。README troubleshooting 里也承认默认参数需要显式传，否则会报 cast/null 错误。

第五个问题：它的 GitHub maturity 很低。当前仓库显示 2 stars、0 forks、7 commits；README 说从 releases/1.0.0/ 文件夹下载 AAR/JAR，但 GitHub Releases 区域显示 “No releases published”。仓库里确实有 releases/1.0.0 文件夹，包含 AAR/JAR。

这不是说不能借鉴，而是说不要把它当生产级依赖基座。

4. 对你这个 Android debug MCP 的启发
你真正应该借它的不是“完整实现”，而是这个能力层：

App-side Business Bridge
也就是在你的架构里加一层：

Agent
  -> Desktop MCP Server
    -> ADB Provider
    -> UI Evidence Provider
    -> Log/Crash Provider
    -> App-side Business Bridge
         -> debug APK 内 HTTP/local socket server
         -> exposes selected state/actions
它能补足 ADB/FixThis 不擅长的东西：

当前 screen 的 ViewModel state
当前 user/session/feature flag 摘要
当前 repository mock/live 模式
触发某个 UseCase 并观察 UI/log/state
读取最近业务 event timeline
但你不能让 agent 随便调用业务类 public function。应该改成显式 debug contract。

5. 我建议你采用的改良版
不要做：

class PaymentRepository {
    fun processPayment(...)
    fun refund(...)
    fun clearCache(...)
    fun deleteLocalData(...)
}
然后全部暴露给 agent。

应该做：

interface DebugProbe {
    val id: String
    fun describe(): DebugProbeDescriptor
    suspend fun readState(): JsonObject
    suspend fun invoke(action: String, args: JsonObject): DebugActionResult
}
例如：

class LoginDebugProbe(
    private val viewModel: LoginViewModel,
    private val authRepository: AuthRepository,
) : DebugProbe {

    override val id: String = "screen.login"

    override fun describe(): DebugProbeDescriptor {
        return DebugProbeDescriptor(
            id = id,
            actions = listOf(
                DebugAction("submit", risk = Risk.Low),
                DebugAction("mockLoginSuccess", risk = Risk.Low),
                DebugAction("mockLoginFailure", risk = Risk.Low),
            )
        )
    }

    override suspend fun readState(): JsonObject {
        val state = viewModel.uiState.value
        return buildJsonObject {
            put("screen", "Login")
            put("loading", state.loading)
            put("emailValid", state.emailValid)
            put("submitEnabled", state.submitEnabled)
        }
    }

    override suspend fun invoke(action: String, args: JsonObject): DebugActionResult {
        return when (action) {
            "submit" -> {
                viewModel.submit()
                DebugActionResult.ok()
            }
            "mockLoginSuccess" -> {
                authRepository.debugSetNextLoginResult(LoginResult.Success)
                DebugActionResult.ok()
            }
            "mockLoginFailure" -> {
                authRepository.debugSetNextLoginResult(LoginResult.InvalidPassword)
                DebugActionResult.ok()
            }
            else -> DebugActionResult.error("Unknown action: $action")
        }
    }
}
这样 agent 看到的是受控 debug API，不是任意业务 public method。

6. 它和“点击定位源码”的结合点
androidclaudio 自己不解决 tap → element → source。它能解决的是：

点完以后，业务状态怎么变了？
哪个 UseCase 被调用了？
哪个 Repository 返回了什么？
当前 ViewModel state 是什么？
所以你最终的 debug evidence 应该长这样：

{
  "interaction": {
    "type": "tap",
    "target": {
      "resourceId": "com.example:id/login_button",
      "semanticId": "login.submit_button",
      "sourceCandidates": [
        "LoginFragment.kt",
        "fragment_login.xml",
        "LoginViewModel.kt"
      ]
    }
  },
  "businessStateBefore": {
    "probe": "screen.login",
    "state": {
      "loading": false,
      "submitEnabled": true
    }
  },
  "businessStateAfter": {
    "probe": "screen.login",
    "state": {
      "loading": true,
      "error": null
    }
  },
  "logsAroundInteraction": "...",
  "crashContext": null
}
这里：

ADB / UIAutomator / sidekick hit-test
  -> 负责“点了哪个 UI 元素”

FixThis-style source candidates
  -> 负责“元素可能在哪些源码文件”

androidclaudio-style business bridge
  -> 负责“点击前后业务状态如何变化”
这三个能力合起来才是你想要的。

7. 我给你的最终取舍建议
不建议直接依赖 androidclaudio
原因：

1. 非标准 MCP 协议实现
2. 仓库成熟度低
3. security policy 基本还是模板
4. public/internal method 暴露边界太宽
5. DI 解析和实例真实性风险高
6. complex Kotlin type / suspend / default args / overload 支持不稳
建议吸收它的模式
吸收：

debugImplementation-only runtime bridge
KSP 生成 registry
adb forward 到 debug APK
分组暴露业务能力
mock/live mode
StateFlow 驱动 UI 更新验证
但改成：

显式 DebugProbe，不扫描所有 public functions
标准 MCP 在桌面端实现，APK 内只做 local debug bridge
默认只读，写操作必须 action allowlist
所有输出必须脱敏
所有危险 action 加 risk level
必须记录 interaction/action timeline
禁止无参构造器 fallback 冒充 live instance
8. 你自己的项目应该这样合并它
推荐最终架构：

android-debug-context-mcp
  desktop-server/
    MCP stdio / Streamable HTTP
    adb wrapper
    logcat collector
    screenshot/ui dump collector
    source mapper

  app-sidekick/
    debugImplementation
    local socket or localhost HTTP server
    DebugProbe registry
    current screen / route / state
    interaction tracker
    business event timeline

  source-indexer/
    XML id -> layout file
    ViewBinding id -> Fragment/Activity usage
    Compose testTag -> composable file
    DebugProbe id -> owning source file
一句话评价：

androidclaudio 不是你的主方案，但它证明了“debug APK 内嵌 app-side bridge”这条路是对的。你应该借它的 KSP + debug runtime bridge 思路，但用更窄、更安全、更可解释的 DebugProbe API 重写。

/


