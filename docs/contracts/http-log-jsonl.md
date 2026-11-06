# HTTP 日志契约(`http_*.jsonl` v1 rev6 + human console)

- 状态:**frozen**(v1 rev6,2026-11-06)。Step 1 的 DoraLive producer 与 Step 2 的 reader 已双向核对:DoraLive 的六类 golden 行(`server/tests/fixtures/wire/dora_golden.jsonl`)和 K40 真机拉下的 11 行都被 reader 接受，producer 写的 `outcome` 被采用，`dora` wire 的自比对全部 MATCH。此后 breaking 变更须 bump `v`;新增 optional 字段、枚举取值仍不 bump。
- 权威来源:**本文件**。它取代 `submodulepoppo/docs/reference/http-log-jsonl-schema.md`(rev5);那份文件在 Step 3 改为指向这里的一行指针加 Poppo 实现注记。
- 参与方:
  - consumer:`android-debug-mcp`(`server/src/profile/*/…_http/*`、`server/src/wire/*`);
  - producer:Poppo(`submodulepoppo` 的 `rtcrequestlibrary`)、Vone(经 `rtc:request` 坐标消费同一个库,`submodulevone/common/network/build.gradle:64`)、DoraLive(`:apps:dora:debug`,数据来自 `core:network` 的 `GatewayTrace`)。
- 范围:一份**机器契约**(JSONL,§1–§5),外加一份**人读契约**(console 分段,§7)。consumer 只读 JSONL,不解析 console。

## 0. 设计原则

1. **一行是一次上线尝试**:一条 JSONL 记录对应一次真实的 HTTP 交换。同一个逻辑调用被重放时,产生多行(`request.attempt` 区分)。
2. **语义差异放 profile,不放 wire**:哪些参数是公参、哪些 header 算设备头、按什么字段区分同一 path 下的不同调用,这些因 app 而异的东西属于 consumer 的 profile 策略(§6),不进 schema。schema 只承载 producer 才知道的**事实**:是否加密、走的哪个路由、结局是什么。
3. **producer 才知道的事实由 producer 给权威值**:`outcome`、`request.encrypted`、`response.app.ok` 都由 producer 计算。consumer 只在字段缺失时退回推断。
4. **producer 先脱敏,再扇出**:同一份脱敏后的记录同时供给 JSONL、console 和 app 内调试工具(§5)。consumer 侧的脱敏是第二层兜底,不是第一道防线。
5. **一个 `seq` 贯穿所有输出**:同一次交换在 JSONL 的 `seq`、console 的 `#seq`、app 内调试工具的 id 上是同一个数。

## 1. 格式与兼容

- UTF-8 JSONL:每行一个独立的 JSON 对象,以 `\n` 结尾,行内不含裸换行。每一行都可以单独解析。
- 顶层 `v` 是 major 版本号,当前为 `1`。**consumer 必须拒绝未知的 `v`。**
- **Tolerant reader**:
  - consumer 必须忽略未知字段;
  - rev6 新增的字段都是 optional,缺失时按 rev5 的语义处理(见各字段的“缺失时”一栏);
  - 枚举(`outcome`、`body.omittedReason`、`error.phase`、`owner.role`)出现未知取值时当作 opaque 处理,不得报错。
- producer 在同一个 `v` 下不得修改既有字段的类型、语义或可空性(rev1–rev6 的 draft 期改动记在 §11;冻结后不再有例外)。
- rev6 的每一项都是新增 optional 字段或语义澄清,所以 rev5 的 reader(`record.ts` 每一层都是 `.passthrough()`)能原样读 rev6 的记录,rev5 的 producer 写出的记录也仍然合法。**这是 Step 1–4 可以逐步落地、各自回退的前提。**

## 2. 顶层字段

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `v` | int | ✓ | `1` |
| `runId` | string | ✓ | opaque 的进程运行 id:同一次运行内不变,不同运行之间不重复。consumer 不解析它的内部结构 |
| `seq` | int | ✓ | 进程内的交换序号:从 1 开始,每条记录加 1,单调递增。**等于** console 的 `#seq`(§7)。稳定主键是 `(runId, seq)` |
| `pid` | int | ✓ | 进程 id |
| `tsMs` | long | ✓ | 这次尝试开始的时间,epoch 毫秒 |
| `durationMs` | long | ✓ | 从发出到收完响应或抛出异常的耗时,毫秒 |
| `method` | string | ✓ | HTTP method |
| `url` | string | ✓ | 完整 URL(含 query),其中敏感参数按 §5 打码 |
| `path` | string | ✓ | 不含 query 的 URL path,是**主过滤键** |
| `host` | string | ✓ | URL host |
| `protocol` | string \| null | ✓ | `http/1.1`、`h2` 等,取 OkHttp 的命名;连接没建立时为 `null` |
| `heartBeat` | bool | ✓ | 是否属于心跳 / 低价值后台请求。由 producer 分类 |
| `outcome` | string | optional(rev6) | 这次尝试的权威结局,见 §4。**缺失时**:consumer 按 §4 的退回级联自己推导 |
| `request` | object | ✓ | §3.1 |
| `response` | object \| null | ✓\* | 收到 HTTP 响应时存在 |
| `error` | object \| null | ✓\* | 传输层失败时存在 |

\* **不变量 X**:`response` 与 `error` **恰好有一个非 null**。

## 3. 子对象

### 3.1 `request`

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `headers` | pair-list | ✓ | 实际发出的请求头 |
| `params` | pair-list | ✓ | URL query 参数,按 wire 顺序排列,重复的键也保留;没有值的参数归一化成 `""` |
| `decoded` | object \| null | ✓ | **app 层的明文请求语义**(rev6 澄清):调用方真正传的业务字段,已经剥掉传输层的编码、加密和封装,并按 §5 脱敏。具体内容由各 producer 的附录定义。无法给出时为 `null` |
| `body` | Body | ✓ | §3.4 |
| `owner` | object | optional(rev5) | `{role}`,`role` 取值为 `"Current"` / `"Candidate"` / `"Anonymous"` / `"Untagged"`。只记角色,**不带** uid、token 或密钥。**缺失时**:视为未知,不比较 role |
| `encrypted` | bool | optional(rev6) | app 层的载荷(body 或参数)是否以加密形式上线。为 `true` 时,`decoded` 是那份载荷唯一可读的形式。**缺失时**:consumer 退回 profile 定义的推断(Poppo:params 里有 `_sign`) |
| `route` | object | optional(rev6) | 网关路由调用的身份 `{controller: string, method: string}`:多个逻辑接口共用同一个 `path` 时(Dora 的路由网关),用它区分。不是路由调用时省略。**缺失时**:只按 `method + path` 加 profile 的判别字段分组 |
| `attempt` | int | optional(rev6) | 同一个逻辑调用第几次上线,从 1 开始。协议层重放(例如 Dora 收到 10201 后的整链重发)时大于 1。**缺失时**:视为 `1` |

### 3.2 `response`(`response != null` 时)

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `status` | int | ✓ | HTTP 状态码 |
| `headers` | pair-list | ✓ | 响应头 |
| `body` | Body | ✓ | §3.4;`text` 是**解密、解压之后**的完整文本 |
| `app` | App \| null | ✓ | §3.3;body 不是这个 producer 能识别的业务信封时为 `null` |

### 3.3 `response.app`(App)

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `status` | string \| null | ✓ | 信封的 `status` 键(Poppo 为 `"ok"` / `"err"`);信封里没有这个键时为 `null` |
| `code` | int \| null | ✓ | 信封的业务码 |
| `errCode` | string \| null | ✓ | 信封的 `err_code` |
| `errMsg` | string \| null | ✓ | 信封的 `err_msg` |
| `message` | string \| null | ✓ | 信封的 `message` |
| `ok` | bool \| null | ✓ | 业务是否成功,用的是 producer **现网的判定函数**,不是启发式;判定不了时为 `null` |

- `app` 只取自完整的 `body.text`,永远不取自 `preview`。
- `app == null` **不等于成功**。它只说明 body 不是可识别的信封;这到底是正常的(资源、H5),还是协议错误(Dora 的 malformed),由 `outcome` 表达。

### 3.4 Body(`request.body` 与 `response.body` 同构)

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `contentType` | string \| null | ✓ | body 的 `Content-Type`,原样照抄 |
| `charset` | string \| null | ✓ | 把字节解码成 `text` / `preview` 时用的 charset |
| `text` | string \| null | ✓ | **完整**的 body 文本:已经 content-decode、已经 app 解密、已经按 §5 脱敏。**永远不放截断的内容** |
| `textBytes` | int \| null | ✓ | `text` 的 UTF-8 字节长度 |
| `omittedReason` | string \| null | ✓ | `null` 表示 body 完整在 `text` 里;否则是省略的原因:`no-body` / `oversize` / `binary` / `file` / `encoded` / `one-shot` / `duplex` / `decode-failed` |
| `preview` | string \| null | ✓ | 只用于 oversize:前 ≤ 64 KiB,在 UTF-8 码点边界截断,已脱敏;给不出干净的开头(例如是密文、或不是 UTF-8)时为 `null` |
| `previewBytes` | int \| null | ✓ | `preview` 的 UTF-8 字节长度 |

**三条 body 不变量**(consumer 严格校验;producer 违反就是契约 bug):

- **I1**:`text != null` ⟺ `textBytes != null` ⟺ `omittedReason == null`
- **I2**:`preview != null` ⟹ `omittedReason == "oversize"`(必要条件,不是充分条件)
- **I3**:`preview != null` ⟺ `previewBytes != null`

另外:

- oversize 的阈值约为 1 MiB。producer 不为了算 `textBytes` 去读完一个超大的 body。
- **重序列化**(rev6 澄清):JSON body 在脱敏后可能被 producer 重新序列化,所以 `text` 与 wire 上的报文**语义等价**,但字节不一定相同(空白、键的转义可能不同);`textBytes` 量的是写进文件的那份 `text`。

### 3.5 `error`(`error != null` 时)

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `type` | string | ✓ | 异常的**全限定**类名;平台给不出全限定名时用 simple name |
| `message` | string \| null | ✓ | 异常消息,**经过 producer 的文本脱敏**(传输异常的消息常常带着完整 URL 和签名) |
| `phase` | string \| null | ✓ | `dns` / `connect` / `timeout`;`write` / `read` / `canceled` 是预留值;判断不了时为 `null`,不要猜 |

- `error` 只表示**传输层或拦截器层**的失败。业务失败永远落在 `response` 里。

### 3.6 pair-list

`headers` 和 `params` 都是有序列表 `[{"name": string, "value": string}]`,不是 map:保留顺序、大小写和重复键,`value` 永远不为 null。

## 4. `outcome`(rev6)

| 值 | 含义 |
|---|---|
| `transport_error` | `error != null` |
| `http_error` | 收到响应,但 `response.status` 不在 2xx(即使 `app.ok == false` 也归这里) |
| `malformed` | 收到 2xx 响应,但 producer **期待一个业务信封**,而 body 不是:不是 JSON、不是信封、或解密失败 |
| `app_error` | 2xx,`app != null` 且 `app.ok == false` |
| `ok` | 以上都不是 |

- producer 按**上表的先后顺序**判定,写出权威值。只有 producer 知道一个 2xx 的非信封 body 算正常(资源、H5)还是协议错误,所以 `malformed` 只能由 producer 给出。它不属于 rev4 删掉的那类“可派生的便利字段”。
- 不期待信封的 producer(例如 Poppo 的资源请求)**永远不写** `malformed`。
- **退回级联**(字段缺失时 consumer 推导;rev5 的行为原样保留):`error != null` → `transport_error`;status 不在 2xx → `http_error`;`app?.ok === false` → `app_error`;其他 → `ok`。也就是说,rev5 的记录永远推不出 `malformed`。
- 未知的 `outcome` 值当作 opaque:consumer 不报错,按退回级联重新推导,并在结果里标明这一点。

## 5. producer 侧脱敏不变量

**同一份脱敏后的记录,扇出到这个 producer 的所有输出**:JSONL、console(§7)、app 内调试工具(如 DoraLive 的 `scripts/dora net`)。不允许每个输出各自脱敏。

处理顺序是规范的一部分,**不能调换**:

1. **展开**:把装着 JSON 的字符串字段解析成 JSON 树,这样里面的敏感字段才能被遍历到。必须展开的有:
   - 路由请求体的 `params_json`(Dora);
   - 字符串形式的信封 `data`;
   - Poppo `request.decoded` 里装着 JSON 的字符串字段(具体有哪些字段在 Step 3 核实;本仓库没有搜到 `"_param"`)。
   展开后的对象写进 `request.decoded`;`body.text` 里放展开后的形式还是原始字符串,由 producer 自己定,但两处都必须已经脱敏。
2. **按键名递归打码**:遍历 `request.decoded`、`request.params`、`request.headers`,以及请求体和响应体的 JSON 树。键名命中凭据名单时,把值换成掩码:
   - 结构化值的掩码是字面量 **`"<redacted>"`**,和 consumer 的 `ALIAS` 规则一致(`wire/compare.ts:58`);
   - **空值保持为空**(`""` 不打码),因为 wire 比对看的就是“空”还是“有”;
   - 子树整个命中时(例如 `crypto`),整棵子树替换成 `"<redacted>"`。
3. **重建派生字段**:`url` 用打码后的 `params` 重新拼出来,不用正则在原 URL 上替换。`error.message` 走 producer 的文本脱敏。
4. **扇出**。

**凭据名单**(最低集合;每个 producer 的附录可以加,不能减):

- 签名和令牌:`_sign`(Dora 里它就是 access token)、`_token`、`access_token`、`refresh_token`、`auth_token`、`ext_token`、`token`、`authorization`;
- 网关密钥:**`crypto` 整棵子树**(Dora 登录回包 `crypto.{key, key_version, algorithm}`)、`crypto_key`、`secret`;
- 风控:`yidun_token`;
- 口令和验证码:`password`、`new_password`、`old_password`、`sms_code`、`email_code`、`auth_code`、`code_verifier`;
- header:`Authorization`、`Cookie`、`Set-Cookie`、`Set-Cookie2`、`Proxy-Authorization`(按名字匹配,不分大小写;header 名保留,只遮值)。

**明确不打码**:

- 信封的 `code` / `message` / `status`。所以 producer **不能**用 consumer 那种按整词匹配 `code` 的正则(`wire/project.ts:83`),否则业务码会被抹掉。
- uid、房间号、设备 id 这类标识。它们的别名和脱敏由 consumer 负责(`wire/project.ts` 的 `Aliaser`、`collect_bundle` 的 Q6 规则)。

**consumer 的义务**:consumer 侧的脱敏(`redact.ts` 在 `collect_bundle` 出口、`project.ts` 在 `wire_snapshot` 时)继续生效,作为第二层。它**不是**第一道防线:`redact.ts` 本来就不碰 body 的 `text` / `preview`。

**只在 debug 构建写**:release 不产出本契约的任何输出,也不随包发布(各 producer 的附录写明各自的门控机制)。

## 6. consumer 规则(Step 2 已实现,2026-11-06)

- `outcome` 存在且是已知值时直接采用(`derivePoppoHttpOutcome`,`server/src/profile/poppo-vone/poppo_http/match.ts`);缺失或未知时退回级联。`search_evidence` 的 `outcome` 查询可以取 `malformed`。digest 在有 `request.route` 时带 `route`(`controller/method`),`attempt` > 1 时带 `attempt`。
- 判断是否加密时，先读 `request.encrypted`,缺失才按 Poppo 的规则推断(params 里有 `_sign`)。
- wire 投影和比对由 profile 的 **wire 策略**(`server/src/wire/policy.ts` 的 `WirePolicy`;`Profile.wire`)参数化:公参键(`globalKeys`)、易变值(`volatileKeys`,只比有无和位置)、设备头(`deviceHeaders`)、默认分组字段(`discriminators`)、业务字段是否总在 `request.decoded`(`fieldsFromDecoded`)。`POPPO_WIRE` 就是此前写死的常量(`baseline_diff.py` 的语义，交叉核对测试不变);`DORA_WIRE` 在 `server/src/profile/dora/index.ts`:公参取自 DoraLive 的 `CommonParamNames`,设备头 `X-Device` / `X-Platform`,不按字段分组，业务字段一律来自 `request.decoded`。`wire_snapshot` / `wire_diff` 用调用传的 `profile`,否则 run 自己的 profile,否则 Poppo 的。
- 有 `request.route` 的记录按路由分组:组键是 `METHOD path [route=controller/method,…]`。没有 route 的记录组键不变。
- `request.attempt` > 1 的记录(协议层重放)不进快照，计入 `replays`:应用只发起了一次调用，算进去会被判成 `DUPLICATE`。

## 7. human console 契约(人读,MCP 不解析)

- **段 tag**(扁平字符串,`/` 只是命名约定):
  - 请求:`http/request/digest`、`http/request/header`、`http/request/param`、`http/request/body`;
  - 响应:`http/response/digest`、`http/response/header`、`http/response/body`;
  - 失败:`http/error`;
  - 心跳:`http/heart-beat`。`heartBeat == true` 的交换,所有段都归到这个 tag 下。
- **`#seq`**:每段第一行以 `#<seq>  ` 开头,`<seq>` 和这次交换的 JSONL `seq` 是**同一个数,出自同一个计数器**。按 `#<seq>` 过滤,就能拿到整条交换。
- **原子 flush**:同一交换的所有段先在内存里攒齐,在进程内的一把锁里一次输出。进程内两条交换的段不会交错。
- **分片**:单段超过平台 console 单条上限(Android logcat 约 4 KB,iOS 更短)时,在码点或换行边界切开,每片以 `#<seq> (i/n)  ` 开头。
- **body 上限**:console 里每段 body 可以比 JSONL 截得更短(建议 16K 字符)。被截时末尾加一行,指向 JSONL 里这条交换的 `seq`。
- **digest 格式**:请求是 `METHOD path`,加上 protocol 和完整 URL(已打码);响应是 `METHOD path -> status durationMs`,有 `outcome` 时附上 `outcome`。
- **内容**:用 §5 脱敏后的同一份记录渲染。console 输出**不得**进入崩溃上报 breadcrumb,也不得进入产品的持久化日志(这是 producer 附录要写明的隔离方式)。
- console 是给人读的,格式可以小改而不 bump `v`。机器一律读 JSONL。

## 8. 文件与滚动(reader 契约)

- **目录**:Android 是 `getExternalFilesDir(null)/http-logs/`,即 `/sdcard/Android/data/<pkg>/files/http-logs/`(MCP 用 `adb pull` 就能拿,不需要 `run-as`)。iOS 不在 MCP 的范围内;producer 可以写进 app 容器的 `Caches/http-logs/`。
- **文件名**:`http_<设备本地日期 yyyy-MM-dd>_<index>.jsonl`,`index` 从 0 开始。
- **滚动**:单个文件约 20 MiB 换下一个(软上限,最多超出一个落盘批次)。
- **保留**:最近 3 个本地日期,或总计 100 MiB,取更小的那个;超出时删最旧的文件。
- **写入**:调用线程只入队,后台单线程批量落盘。每条记录(整行连同 `\n`)原子写出。活动文件的末尾可能是半行,reader 跳过它。
- **运行与文件**:文件只是存储分片,**不是运行边界**。取某次运行,要对 `http_*.jsonl` 全部文件按 `runId` 过滤、按 `seq` 排序;多个文件合并时按 `(tsMs, runId, seq)` 排序。

## 9. producer 映射附录

### 9.1 Poppo / Vone(`rtcrequestlibrary` 的 `CustomHttpLoggingInterceptor`、`HttpLogRecord`、`HttpJsonlLogger`)

| 字段 | 取值 |
|---|---|
| 拦截位置 | OkHttp 拦截器,位于 `OkMonitorInterceptor` 的内层;只在 `RtcRequestHelper.isDebug` 时挂载 |
| `seq` | `REQUEST_SEQ`(`AtomicInteger`),和 logcat 的 `#seq` 共用 |
| `request.decoded` | `_random` / `_sign` 解密后的 JSON 对象(`decodeParams`);没有加密参数时为 `null`。Step 3 起,里面装着 JSON 的字符串字段按 §5 第 1 步展开 |
| `request.encrypted` | Step 3 起写出：请求带着签名载荷(`_random` 和 `_sign` 都非空)时为 `true`。GET 的载荷在 URL query;已登录的表单 POST 只在 `FormBody` 里(`ParamInjectHelper` 不拼进 URL),两处都认，`decoded` 按同一处解密 |
| `request.route` | 不写 |
| `request.attempt` | 不写(缺省为 1) |
| `request.owner.role` | Step 3 起写出：取自请求的 owner tag(`RequestOwner`,`common/session/.../SessionTypes.kt:61`)的子类名，没有 tag 为 `Untagged`。`rtcrequestlibrary` 在 `common` 之下，按类名 `com.androidtool.common.session.RequestOwner` 反射取 tag 类型(Poppo / Vone 同名同包);宿主里没有这个类时不写 |
| `response.app` | 信封键 `status` / `code` / `err_code` / `err_msg` / `message`;`ok = !ServiceErrorController.isBizException(code ?: httpStatus, status ?: "")` |
| `outcome` | Step 3 起写出,只用 `transport_error` / `http_error` / `app_error` / `ok`,**不写 `malformed`**(资源和 H5 的非信封响应是正常的) |
| 脱敏 | Step 3 起在 producer 侧落实 §5(此前只有 consumer 在 bundle 出口脱敏);名单至少加上 `_token` |
| console | 经 `IRTCRequestBridge.logDebug` 进 `VLog`,段 tag 和 `#seq` 都按 §7。Step 3 核对它进不进 VLog 的文件和崩溃上报,按 §7 隔离 |
| Vone | 经 `rtc:request` 坐标消费同一个库(`submodulevone/common/network/build.gradle:64`)。Step 4 是升级坐标版本,并核对 Vone 的 `isBizException` 和 owner tag,不是改 Vone 的源码 |

### 9.2 DoraLive(mimi 网关,`core:network` → `:apps:dora:debug`)

**数据来源**:`core:network` 的 public 端口 `GatewayTrace`,由包住 `GatewayTerminal` 的 `TracingTerminal` 在**每次上线尝试**时调用。

- 拦截链内层的重放(`ReactionInterceptor` 收到 10201 后调 `call.replay()`)每次都会经过,所以会记两次;
- `TokenRefresher` 直接用 `Transport`,不进链,所以**从结构上**不会被记录;
- release 的 `GatewayTrace` 是 `None`,不会包装 terminal。

**producer** 在 `:apps:dora:debug`:先统一脱敏(`SanitizedExchange`),再扇出到 `NetworkRing`(调试页和 `scripts/dora net`)、console 和 `http_*.jsonl`。

| 字段 | 取值 |
|---|---|
| `runId` | 每个进程生成一个 UUID(opaque)。如果以后把 `CrashContext` 的 `boot_id` 暴露出来,可以复用它来关联 Crashlytics |
| `seq` | `:apps:dora:debug` 进程内的计数器,在一次尝试**完成时**分配;JSONL、console、`NetworkRing` 共用 |
| `tsMs` / `durationMs` | `TracingTerminal` 的入口时间和耗时(wire 发送加信封解码) |
| `url` / `params` | `call.params`(`_uid`、公参、`yidun_token`、`_sign`、`dev`)后面接 GET 自己的 `call.query`,按 wire 顺序;null 值丢掉,空值保留(`_sign=`)。`url` 用打码后的 `params` 重新拼出来 |
| `request.headers` | `Transport` 实际发出的 `Accept`、`X-Device`、`X-Platform`、`Content-Type` |
| `request.body` | POST 放**加密前**的明文 JSON(`GatewayCall.body`),`contentType` 为 `application/json`;GET 为 `no-body` |
| `request.decoded` | 业务字段对象。GET 是自己的 `call.query`;POST 是明文 body,其中 `params_json` 已展开成嵌套对象 |
| `request.encrypted` | 已登录、路径允许加密、有网关密钥的 POST,且 body 确实以 `{"data": <ciphertext>}` 形式上线时为 `true`。由 `EncryptionInterceptor` 记录这个事实,不靠比较 payload 推断 |
| `request.route` | body 是 `RouteBody`(`{"controller", "method", "params_json"}`)时为 `{controller, method}` |
| `request.attempt` | `GatewayCall.replay()` 时加 1 |
| `request.owner.role` | 调用带了某次登录的凭据(`call.signed != null`)时为 `Current`,否则为 `Anonymous` |
| `response.body.text` | **解密后**的信封文本:明文回包就是原文;加密回包是解密得到的 inner JSON。由 `GatewayResponse` 把已经解析好的信封对象交出来,不另外再解密一次 |
| `response.app` | `status = null`、`code`、`errCode = null`、`errMsg = null`、`message`;`ok` 取 `GatewayResponse` 的判定:加密回包只有 `code == 0` 算成功,明文回包是 2xx 且 code 为空或 0 |
| `outcome` | `Outcome.Unreachable` → `transport_error`;status 不在 2xx → `http_error`;`Outcome.Malformed`(不是 JSON、不是信封、解不开)且 2xx → `malformed`;`Outcome.Failed` 且 2xx → `app_error`;`Outcome.Ok` → `ok` |
| `error` | `type` 是 cause 的类名;`message` 经 `Redaction.redact` 文本脱敏;`phase` 的对应关系是:`ConnectTimeoutException` → `connect`,`HttpRequestTimeoutException` / `SocketTimeoutException` → `timeout`,DNS 解析失败 → `dns`,其他 → `null` |
| `heartBeat` | 目前恒为 `false`:心跳走 MQTT,网关没有心跳调用。以后出现心跳类调用时，再由 `:apps:dora:debug` 按 path 分类 |
| 不进记录 | `Stale` / `Reacted`(是外层的逻辑投影,在 `MetricsInterceptor` 那一行摘要里)、DTO 解不进去(在 terminal 之后发生,所以 `outcome` 仍是 `ok`)、`ApiDomainDiscovery` 的探测请求 |
| 脱敏 | 两层:**L1** 在 `core:network` 的 `TracingTerminal`,按 `CommonParamNames` 遮 `_sign` / `yidun_token`,并遮凭据 schema 里的 `access_token` / `refresh_token` / `crypto`(`IssuedCredentials.kt`);**L2** 在 `:apps:dora:debug`,按 §5 的顺序展开、按键名递归打码,键名是否敏感问 `core:logging` 的 `Redaction`(名单只在那里维护) |
| console | 由 `:apps:dora:debug` 自己持有的 `RedactingLogWriter(platformLogWriter())` 输出,**不经过** `Log` 门面和 `LogOutput`,所以从结构上不会进入 `CrashBreadcrumbs`、`dora.log`(`RollingFileLogWriter`)和 `LogRing`。`MetricsInterceptor` 原有的一行 `Gateway` 摘要保持不变 |
| 门控 | 实现全部在 `:apps:dora:debug`:Android 是 `debugImplementation` 加 `checkReleaseHasNoDebugTools`,iOS 是 `iosDebugToolsIncluded`。`.android-debug-mcp/profile.json` 放在 DoraLive 仓库根，写 `dora`(`server/src/profile/dora/index.ts`:同一个 `poppo_http` source,外加 DoraLive 的 wire 与 logcat 时间线排除的段 tag);Step 2 之前曾临时写 `poppo-vone`,因为当时未知的名字会让 `start_session` 报 `profile_unknown` |

**ADR 约束**:DoraLive 的 ADR-0007(“请求和响应体在任何构建里都不记日志”)和 ADR-0012(接口指标“不记参数、请求体和凭据”)写的都是**不记报文**。DoraLive 采用本契约,意味着在 debug 构建里放宽这两条:允许在内存检查器里看报文、在 logcat 里输出、在 external files 上落盘 3 天 / 100 MiB,前提是 producer 先按 §5 脱敏。这需要 DoraLive 的用户**明确批准**,并在落地的同一个 commit 里给两个 ADR 各补一行带日期的说明。批准之前,Step 1 不合入 DoraLive 的 `dev`。

## 10. 验收(按 rollout 步骤)

| 步骤 | 可核对的标准 |
|---|---|
| Step 0 | 本文件审过;`docs/README.md` 的索引里有它 |
| Step 1(DoraLive) | (a) 覆盖六类交换的 golden JSONL(GET 成功、加密 POST、`app_error`、`malformed`、`transport_error`、oversize):**用现有的 rev5 reader**(`parsePoppoHttpLine`)解析,0 失败,I1–I3 和 X 都成立。(b) 三处输出里都找不到登录回包的 token 和 `crypto` 内容、`params_json` 里的 `password`、非空 `_sign` 的值。(c) 同一次交换在 console 的 `#seq`、JSONL 的 `seq`、`scripts/dora net` 的 id 一致。(d) release 产物里搜不到 producer 的类 |
| Step 2(MCP) | `outcome` 优先;`malformed` 可以查询;`request.encrypted` 优先于推断;新增的 `dora` profile 按 route 分组,`DEVICE_HEADERS` 和 `GLOBAL_KEYS` 来自 profile;rev5 的 fixture 回归全部通过 |
| Step 3(Poppo) | 写出 `outcome` / `encrypted`;producer 侧按 §5 脱敏(含 `decoded` 里嵌套 JSON 的展开);rev5 和 rev6 的 reader 都能读 |
| Step 4(Vone) | 升级 `rtc:request` 坐标后,Vone 的 debug 包写出 rev6 字段;`wire_diff` 的 S16 交叉核对没有退化 |
| 冻结 | Step 1 和 Step 2 双向核对通过后,本文件的状态改为 frozen(2026-11-06 已冻结) |

## 11. 修订记录

- rev1–rev5:见 `submodulepoppo/docs/reference/http-log-jsonl-schema.md` 的决策记录(pair-list、统一 body 对象、`runId`、三条不变量、`response.app`、`owner.role` 等)。
- **冻结(2026-11-06)**:Step 2 的 reader 落地并与 DoraLive 双向核对后,v1 rev6 冻结(见文件头)。
- **rev6(2026-11-06)**:契约的权威位置迁到 android-debug-mcp,producer 增加 DoraLive。改动如下,均为新增 optional 字段或语义澄清,**不 bump `v`**:
  - 新增 `outcome`(含 `malformed`)、`request.encrypted`、`request.route`、`request.attempt`;
  - `request.decoded` 的定义放宽为“app 层的明文请求语义”;
  - `body.text` 的定义明确为“已脱敏,可能重新序列化”;
  - `error.message` 必须经过文本脱敏;
  - producer 侧脱敏不变量(§5),以及展开先于打码的顺序;
  - human console 契约(§7),原先只在 Poppo 的实现注释里;
  - 一行等于**一次上线尝试**(原来写的是“一次请求”)。
  - **为什么不升 v2**:这些问题(路由撞组、按 `_sign` 推断加密、malformed 被判成 ok、重放)每一个都能靠新增 optional 字段或 consumer 侧的 profile 策略解决,没有一项需要改既有字段的类型或语义;而升 v2 会迫使三个 producer 和 consumer 在同一天切换,失去逐步落地、各自回退的能力。只有出现真正的 breaking 需求(body 分块或流式记录、headers 改成结构化)时才升 v2。
