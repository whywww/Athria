# Athria 统一多运动计划：交互与展示设计文档


> 术语说明：本文中的 **Dashboard** 指完整的 Athria App；**Overview** 和 **Plan** 是 Dashboard 内的页面；**LLM** 指通过 MCP 连接 Athria 的外部 Agent。

## 1. 设计目标

Athria 中，用户始终只关注一个 Current Mesocycle。力量、跑步、骑行、球类和恢复训练都属于同一个周期，不以多个独立计划呈现。

外部 LLM 是计划的主要设计者：它根据用户的目标、训练历史、能力、偏好和限制，一次生成完整 Mesocycle，并负责之后的周期性 review、大范围修改和重建。Dashboard 不与 LLM 争夺“专业计划设计”的职责，而是把计划清晰地呈现给用户，帮助用户理解、执行和完成有限的日常调整。

本次设计需要解决四个核心问题：

1. 用户能快速理解整个 Mesocycle 的目标、阶段与不同运动之间的协调关系。
2. 用户能在统一周历中查看整个周期，而不是分别查看有氧和无氧计划。
3. 用户点击任何 session，都能看到当天完整、可执行的处方，而不是阅读模糊 notes。
4. 用户能看懂计划如何逐周 progression，以及计划为什么发生了适应性调整。

## 2. 核心产品原则

### 2.1 一个计划，多种训练

Athria 只有一个 Current Mesocycle。所有训练共享同一时间轴和同一周历。不同运动可以使用自己的指标、颜色和处方形式，但不能被拆成互不相关的计划页。

### 2.2 LLM 负责设计，Dashboard 负责消费

LLM 负责：

- 创建完整 Mesocycle。
- 统一协调不同运动的刺激、优先级和恢复。
- 一次生成全周期的周计划和每日具体处方。
- 编写 progression guideline。
- 进行 weekly review、phase review 和重大重建。
- 解释重要调整的原因与影响。

Dashboard 负责：

- 清晰展示完整计划。
- 提供 Today / Next Training Day 执行入口。
- 记录完成、跳过和实际完成情况。
- 支持移动、临时缩短或有限替换等轻量调整。
- 在需要专业重规划时，引导用户让 LLM 调整计划。

### 2.3 远期计划完整可见，但不是不可变合同

用户从计划开始时就可以查看全部未来周和完整 session 处方。越远的训练越可能在 review 后发生变化，因此界面需要表达“当前计划版本下的完整安排”，而不是制造远期计划绝对确定的错觉。

### 2.4 Template、周处方和实际执行各司其职

- Template 表达相对稳定的训练结构，例如 Easy Run、Intervals、Lower Strength A。
- Weekly Session 表达该模板在某一周的具体剂量，例如 40 分钟 Easy Run 或 6 × 800m。
- 实际执行记录表达用户最终做了什么。

用户在 Plan 中主要看到 Weekly Session，而不是先理解 Template Library。

### 2.5 不制造虚假的统一负荷

力量、跑步、球类和恢复共享时间轴，但分别展示自己的 progression。Athria 不将它们强行加总成一个缺乏依据的“总训练量”或“总疲劳分”。

## 3. Dashboard 整体信息分工

### Overview

回答：“我现在最需要做什么？”

- Today / Next Training Day。
- 本周完成情况。
- 下一次关键训练。
- 待处理的调整建议或 review。
- 完成、跳过、移动等快捷操作。

### Plan

回答：“整个周期为什么这样安排，接下来每周具体做什么？”

- Mesocycle Target。
- Progression by Domain。
- 全周期 Weekly Plan。
- Session Detail。
- 发生调整时的解释。

### Templates

回答：“LLM 或高级用户可以复用哪些训练原型？”

- 展示稳定训练结构。
- 不作为普通用户理解当前计划的首要入口。
- 不与当前 Weekly Plan 混为一体。

## 4. Plan 页总体结构

Plan 页固定采用以下三层结构：

```text
1. Mesocycle Target
2. Progression by Domain
3. Weekly Plan for the whole Mesocycle
```

Session Detail 不是第五个页面区块，而是用户点击 Weekly Plan 中的 session 后，从右侧打开的详情层。

调整说明采用情境式展示：只有计划发生过 Adaptive Change，或当前存在待处理建议时，才出现在相关 session、week 或页面顶部，不永久占据一个大区块。

## 5. 第一层：Mesocycle Target

### 5.1 用户需要理解什么

用户进入 Plan 后，应先在一个屏幕范围内明白：

- 这是什么计划。
- 当前第几周、哪个阶段。
- 最主要的目标是什么。
- 其他运动为什么存在。
- 计划受到哪些关键限制。
- 不同运动如何相互协调。

### 5.2 推荐布局

```text
10 周综合训练计划                         Week 3 of 10 · Build
Sep 7 – Nov 15

PRIMARY GOAL
10K 跑进 50:00 · 目标测试 Nov 15
当前基线：约 54:30

SUPPORTING                         MAINTENANCE
力量训练 2 次 / 周                维持主要动作力量
改善跑步经济性                    每周篮球 1 次

CONSTRAINTS
每周最多 5 个训练日 · 工作日 ≤ 60 min · 周日可长距离

COORDINATION STRATEGY
10K 表现优先；篮球计入高强度刺激；下肢力量不安排在长跑前一天；
同日必须组合时，当前阶段的主目标训练优先。
```

### 5.3 信息层级

1. 计划标题、日期范围、当前进度。
2. Primary Goal，标题与内容使用同样的紧凑字号，通过位置和始终可见来体现优先级。
3. Supporting 与 Maintenance 目标。
4. Coordination Strategy。

不要将所有目标平铺为同等权重的标签。混合训练最重要的信息是“当前周期究竟优先优化什么”。

### 5.4 折叠规则

- Primary Goal 与当前进度始终展示。
- Supporting、Maintenance 和 Coordination Strategy 默认折叠到 `Plan details`。
- 用户可在当前页面展开或收起；每次重新进入 Plan 页时恢复默认收起。
- 如果只有一个目标，也保留 Primary 标识，不显示空的 Supporting/Maintenance 区域。

### 5.5 状态表达

- 当前计划正常：显示 `Current plan`。
- 远期部分刚被 LLM 修改：显示 `Updated <date>`，可查看变化摘要。
- 存在未确认的大范围修改建议：显示 `Review proposed changes`，不要把候选计划与当前计划混在同一视图。
- 计划已结束：显示 `Plan completed`，保留历史阅读能力，并提供让 LLM 创建下一周期的入口。

## 6. 第二层：Progression by Domain

### 6.1 作用

Progression by Domain 用独立 timeline 讲清每种训练能力的周期故事线和当前位置，不承担周计划筛选器的职责。Hybrid plan 同一周可以同时处于 Strength Build、Endurance Base 和 Sport Skill Consolidation。

### 6.2 推荐展示

```text
Strength      Foundation W1–2  → Build W3–6       → Deload W7 → Reassess W8
Endurance     Base W1–3        → Build W4–6       → Sharpen W7 → Test W8
Sport Skill   Acquisition W1–2 → Consolidation W3–4 → Variability W5–6 → Integration W7–8
                                      ▲ Current（每行独立）
```

### 6.3 交互规则

- 当前 phase 自动高亮，并有明确 `Current` 标记。
- Timeline 本身不要求点击。
- Hover 或聚焦时可显示 phase 的完整 focus 和日期范围。
- 点击某个 phase 可以作为辅助操作，将页面滚动到该 phase 的第一周，但不能隐藏其他周。
- 当前周跨过 phase 边界时，以周所属 phase 为准，不使用渐变或双高亮制造歧义。

### 6.4 视觉原则

- Phase 颜色应克制，主要用于区分段落。
- 当前 phase 的高亮不能只依赖颜色，应同时使用标签、描边或位置指示。
- 1–4 周短计划仍显示 Timeline，但可以简化为一到两个 phase block。
- Phase 名称由 LLM 提供，界面不强制只能使用 Foundation / Build / Specific 等固定文案。

## 7. 第三层：全周期 Weekly Plan

这是 Plan 页的核心区域。

### 7.1 设计目标

- 用户可以在一个统一日历中查看所有运动。
- 每个 session 在周历中只显示标题，降低密度。
- 同一天可以有多个 session。
- 点击标题后再查看完整处方。
- 日期安排已经考虑 Training Rhythm，用户不需要在这里理解系统如何展开 rhythm。

### 7.2 周历结构

```text
W3 · Strength Build / Endurance Base · Sep 21–27

Mon       Tue          Wed          Thu          Fri       Sat          Sun
Rest      Easy Run     Upper A      Intervals    Rest      Lower A      Long Run
           Lower B                   Basketball
```

每一周包含：

- Week number。
- 各 domain 的 phase 摘要。
- 日期范围。
- 可选的一句本周 focus。
- Mon–Sun 七列。
- 每个 session 的标题 chip。

### 7.3 默认展开方式

首次加载时只展开一个定位周，页面从顶部开始（不自动滚动到该周）；离开后再次进入同一计划时恢复上次离开时的滚动位置。定位周的选择：

- 活跃计划展开当前周。
- 尚未开始的计划展开 Week 1。
- 已结束的计划展开最后一周。
- 其他周全部以紧凑周行展示，但用户可以逐周手动展开，并可同时保留多个已展开周。
- 不提供全局展开或折叠按钮。
- 用户点击任一 domain timeline 中的 phase 时，滚动并展开该 phase 的第一周；其他周的展开状态保持不变，也不隐藏任何计划周。

这套规则统一适用于 4、8、10、16 周及更长计划，不按计划长度切换默认行为。

### 7.4 Session chip 内容

默认只显示：

- Session 标题。
- 运动类型的辅助 icon 或短标签。
- 必要状态，如 completed、skipped、moved、adapted。
- （预计）时长，例如 `40 min`。

不在 chip 中显示完整组次、配速、心率、备注或训练理由。

### 7.5 同一天多个 session

- 同一日的 session 垂直排列，按计划执行顺序显示。
- 按 LLM 给出的顺序排列。
- 日历格高度不应无限增长；超过三个 session 时显示前两个和 `+N more`。

### 7.6 Rest day

- LLM 明确安排的休息日显示 `Rest`。
- 若某日原有训练后来被跳过，显示 `Skipped`，不能把它改成 Rest。

### 7.7 过去、今天和未来

- Today 使用清晰但不抢夺 Primary Goal 的高亮。
- 已完成 session 使用 check 状态，但标题保持可读。
- 部分完成的组合日，在各 session 级别分别展示状态。
- 过去但没有匹配 actual workout、也未被跳过的 session 显示 `Unrecorded`，并提示用户补录、跳过或移动，不自动当作 skipped。
- 未来 session 正常显示计划状态。
- 距离当前日期较远的周可以显示 `May change after review`，但不降低处方完整度。

### 7.8 Session 点击行为

- 点击、Enter 或 Space 打开右侧 Session Detail Drawer。
- Calendar 保持原滚动位置和选中状态。
- 切换同一周的其他 session 时，Drawer 内容直接替换，不先关闭。
- Esc、关闭按钮或点击遮罩关闭 Drawer。
- 关闭后焦点返回原 session chip。
- 用户从其他页面返回 Plan 时，应恢复之前选中的 session 和周历位置。

### 7.9 周级摘要

每周标题处可以显示极简摘要，例如：

```text
Running 24 km · Strength 2 sessions · Basketball 1 session
```

规则：

- 分运动显示，不能汇总成单一负荷。
- 只显示有可靠结构化数据的指标。
- 若距离不可用而时长可用，则显示时长。
- 不因为某类指标缺失而隐藏整个周历。

## 8. Session Detail Drawer

### 8.1 Drawer 的任务

Drawer 回答四个问题：

1. 这次训练的目的是什么？
2. 我具体要做什么？
3. 它与 Base Template 和本周 progression 有什么关系？
4. 如果它被调整过，为什么改变？

### 8.2 信息顺序

```text
Intervals · Thu, Sep 24
Week 3 · Build · Key session · 55 min

Purpose
提高 10K 配速附近的有氧能力，同时控制总高强度量。

Base template
Running · Intervals

Prescription
1. Warm-up     10 min Easy · RPE 2–3
2. Main set    6 ×
               800 m · 4:45–4:55/km · RPE 7–8
               2 min Easy jog
3. Cool-down   10 min Easy

This week's progression
由上周 5 × 800m 增加为 6 × 800m；恢复时间不变。

Why Thursday
与周日长跑保持间隔，并避开周六下肢力量。
```

### 8.3 Base Template 标识

- Session 对应模板时，显示 `Base template` 与模板名称。
- Template 只是来源，不应让用户误以为当前处方仍等于模板默认值。
- 用户可以打开模板详情，但返回时仍回到当前 Session Drawer。
- Session 不对应模板时，不显示空的 Template 区域，也不标记为错误。

### 8.4 不同运动的处方展示

#### Strength

每个动作显示：

- 动作名。
- sets × reps 或 reps range。
- target RPE / RIR（若有）。
- 参考负重（若明确提供）。
- rest。
- tempo、动作提示和替代动作（若有）。

主项和辅助项可分组，但不要默认以肌群列表取代动作处方。

#### Running / Cycling / Rowing / Swimming

按执行顺序显示：

- Warm-up。
- Main set。
- Repeat group。
- Recovery segment。
- Cool-down。

每段展示实际存在的 duration、distance、pace、heart-rate zone、power、cadence、RPE 或 talk test。缺少某个指标时不显示空字段，也不补造数值。

Repeat group 应以视觉嵌套表达：

```text
6 ×
  800 m Work
  2 min Easy jog
```

不要把它展开成 12 个冗长条目，也不要压缩成难读的一行 notes。

#### Ball sports

按训练模块显示：

- Movement preparation。
- Technical skill。
- Tactical block。
- Small-sided game / match play。
- Conditioning。
- Cool-down。

如果是正式比赛，应明确显示 Match / Competition，而不是普通训练模板。

#### Recovery / Mobility / Mind-body

按 block、时长和动作提示显示。视觉权重可以更轻，但不能只显示一个总时长而隐藏内容。

### 8.5 Drawer 内操作

根据 session 状态显示：

- `Add as a completed workout`
- `Skip`
- `Move`
- `Adjust this session`
- `Ask LLM to adjust plan`

`Adjust this session` 只允许轻量变化，并明确说明“只影响这次训练”。如果用户的意图会影响之后多周，界面将其升级为 `Ask LLM to adjust remaining plan`。

## 9. Domain progression 的内容边界

### 9.1 定位

Domain progression 是 LLM 对每种能力在整个周期中如何发展的结构化表达。Phase 决定方向和时间范围；`progression[]` 说明该阶段如何推进。训练结果触发的逐次调整仍由 adjustment rules 和 deterministic tools 承担。

### 9.2 独立 phase timeline

每个实际出现在 Weekly Sessions 中的 domain 都有一条从 W1 连续覆盖到周期结束的 timeline：

```text
Strength      Foundation W1–2 → Build W3–6 → Deload W7 → Reassess W8
Endurance     Base W1–3 → Build W4–6 → Sharpen W7 → Test W8
Sport Skill   Acquisition W1–2 → Consolidation W3–4 → Variability W5–6 → Integration W7–8
```

### 9.3 信息归属

- Phase 保存名称、通用 `phaseType`、周区间、focus 和简短 progression strategy。
- 精确负荷、距离、时长、RPE 或复杂度属于每周 prescription。
- 需要解释“本周相较上周如何变化”时使用 Session `progressionNote`。
- 不再维护第二套逐周 progression metrics 表，也不把不同 domain 合成为单一 load score。

### 9.4 交互

- 每条 domain timeline 独立高亮当前 phase，并使用文字标记而非只依赖颜色。
- Hover / 聚焦 phase 时显示完整 focus 和 progression strategy。
- 点击 phase 可滚动到其第一周，不必打开新的页面。
- 用户不在此直接拖拽修改数值。需要改变 progression 时，使用 `Ask LLM to adjust`。

### 9.5 长周期处理

- 短周期直接展示全部阶段。
- 长周期按 domain 横向滚动，但 Week 轴与 Weekly Plan 保持一致。
- 当前周自动进入可见范围。
- 不把 16 周数据压缩到无法阅读的小字号。

## 10. Training Rhythm 的统一呈现

Training Rhythm 影响 LLM 如何安排日期，但不改变 Plan 页的核心周历结构。

### 10.1 Fixed Week

LLM 按稳定 weekday 安排 session。周历直接显示结果：

```text
Mon Rest · Tue Intervals · Wed Upper · Thu Easy · Fri Rest · Sat Lower · Sun Long
```

如果不同周发生 taper、比赛或 deload，具体 session 可以不同，不必为了保持模板而机械重复。

### 10.2 Flexible Week

Flexible 不等于“没有日期”。在 LLM 完成计划后，每周 session 仍有当前建议日期，并显示在标准周历中。

视觉上可以在周标题旁标记：

```text
Flexible placement · Dates may be moved within this week
```

用户可以移动 session，但界面需要继续显示：

- 本周必须完成哪些 session。
- 已完成、待完成和跳过数量。
- 关键顺序或间隔提示。
- 移动后是否产生冲突。

不要另做一个与其他 rhythm 完全不同的“Required list”主视图。Required 信息可以作为 Flexible Week 的补充摘要。

### 10.3 Interval Rhythm

Interval 的核心是训练序列与间隔，但保存后同样投影到周历：

```text
上次：A Strength · Sep 8
下一次：B Endurance · Sep 10
建议间隔：2 days
```

周历仍按 Mon–Sun 展示具体日期。Session Drawer 或周标题可补充 rotation 信息。

用户移动某次训练时：

- 默认只改变这一次安排，主动询问是否要推迟所有计划。
- 不在用户不知情时自动平移整个未来序列。

### 10.4 Rhythm 信息出现在哪里

- Mesocycle Target 下方可显示一行 rhythm 摘要。
- Flexible Week 的可移动性显示在相关周标题。
- Interval 的序列和间隔显示在 Session Drawer 或 week summary。
- Rhythm 不成为 Plan 页独立的大型编辑器，也不改变三层信息顺序。

## 11. Template 展示与 Sample Templates

### 11.1 Template 的用户心智与边界

Schema v7 的 Template 是单一 domain、稳定且可复用的训练原型。它只保存名称、一句简短 intent，以及节点的顺序、角色、必选性和必填/可选变量；不保存额外说明、使用场景、身份范围、动作、sets/reps、距离、时长、负重、恢复需求或任何默认剂量。节点名称可省略并从 role 派生。Weekly Session 始终保存完整可执行处方。`templateRef` 只是版本化来源，不绑定节点，也不触发复制、推荐或符合性判断。

Core 没有 LLM，不根据目标、阶段、历史或恢复状态推荐剂量。Core 只确定性验证 Template 结构、枚举 ID 和 Weekly Session 约束；显式输入的 progression calculator 与 Template 实例化无关。

### 11.2 Template 详情页

Template 详情重点展示：

- 名称与训练目的。
- 稳定的训练结构。
- 可变化的参数。
- 来源（Built-in 或本地用户 Template）及当前是否被计划引用。

Strength node 同时支持受控的动作模式与目标肌群：至少提供一类，可同时提供；省略 `matchPolicy` 表示 `any`，仅 `all` 显式存储。两类 ID 都必须来自 `strength-2.0` taxonomy，UI 不提供自由文本 ID。

### 11.3 推荐 Sample Templates

#### Running · Easy Run

```text
Purpose
建立或维持低强度有氧能力。

Stable structure
Easy warm-up → Continuous easy running → Easy cooldown

Weekly variables
总时长、距离、RPE/谈话测试、是否加入 strides。
```

#### Running · Intervals

```text
Purpose
发展高有氧或专项配速能力。

Stable structure
Warm-up → Repeated work/recovery → Cooldown

Weekly variables
重复次数、工作段距离或时间、恢复方式、强度目标。
```

#### Running · Long Run

```text
Purpose
发展有氧耐力与长时间运动能力。

Stable structure
Easy start → Continuous endurance block → Optional progressive finish

Weekly variables
时长、距离、地形、末段是否加速。
```

#### Strength · Lower A

```text
Purpose
下肢力量发展或维持。

Stable structure
Squat pattern → Hinge → Unilateral → Calf → Trunk

Weekly variables
具体动作、组次、负重、RPE、休息和动作替换。
```

#### Strength · Upper A

```text
Purpose
上肢推拉力量发展或维持。

Stable structure
Horizontal push/pull → Vertical push/pull → Optional accessories
```

#### Basketball · High-intensity Practice

```text
Purpose
技术决策、反复冲刺和比赛强度适应。

Stable structure
Movement preparation → Technical skill → Small-sided game → Tactical play → Cooldown

Weekly variables
Drill、参与人数、比赛位置、模块时长和预期强度。
```

#### Recovery · Mobility Reset

```text
Purpose
低负荷活动、活动度与恢复。

Stable structure
Down-regulation → Mobility blocks → Easy movement

Weekly variables
身体区域、动作选择和总时长。
```

正式版随应用发布八个只读原型：Easy Run、Intervals、Long Run、Lower Strength A、Upper Strength A、Basketball High-intensity Practice、Mobility Reset、Mind-body Reset。内置原型不写入 SQLite，只能查看或复制为本地用户 Template。

### 11.4 Template 更新的交互预期

- 修改 Template 时，明确提示不会自动改变已经生成的当前计划。
- 如果用户希望当前计划采用新结构，提供 `Ask LLM to adjust`，由 LLM 重新写出完整 Weekly Sessions。
- 不提供模糊的全局“Apply”按钮，以免用户误改未来所有训练。
- 修改 Template 永不修改当前或未来 Session；删除被 Current Plan 引用的用户 Template 返回 `TEMPLATE_IN_USE`。

## 12. 四级调整模型的交互

### Level 0：单次训练内调整

场景：少做一组、少完成一次 interval、缩短训练。

交互：

- 完成训练时记录 actual。
- 显示 planned vs actual。
- 不修改未来计划。
- 如果差异显著，可在完成后询问是否交给下次 weekly review，不立即重建。

### Level 1：局部修复

场景：移动、跳过、设备不可用、临时替换。

交互：

- 用户从 Session Drawer 发起。
- Athria 说明操作只影响哪一次训练。
- 要求选择或填写简短原因。
- 显示是否与相邻关键训练产生冲突。
- 不自动补课。
- 无法安全局部处理时，提供 `Ask LLM to adjust`。

### Level 2：Weekly Review

场景：一周结束，检查计划完成率、关键训练、实际表现与下周安排。

Overview 中显示：

```text
Week 3 review ready
4 of 5 sessions completed · Key session completed
Recovery feedback available · Next week begins Monday

[Review with LLM]
```

Review 结果分三种：

- Continue as planned。
- Adjust next week / several sessions。
- Rebuild remaining progression。

Dashboard 只展示 review 所需摘要并发起与 LLM 的工作流，不自行给出专业判断。

### Level 3：Phase / Mesocycle Rebuild

场景：目标变化、长期可训练时间变化、比赛日期变化、旅行/疾病影响整周、表现明显偏离基线。

交互：

- 页面明确提示这是重大修改。
- 显示 LLM 候选计划与当前计划的变化范围。
- 已完成周保持锁定。
- 用户确认前，当前计划继续有效。
- 用户确认后，显示 `Plan updated` 和简短变更摘要。

## 13. Adaptive Change 的展示

### 13.1 只在有变化时出现

没有调整时不显示空的 Adjustment History 大卡片。变化应贴近它影响的对象：

- Session change 显示在 Session chip 和 Drawer。
- Week-level change 显示在周标题。
- 多周重建显示在 Mesocycle Target 顶部摘要。

### 13.2 变化摘要格式

```text
Adaptive change
Long Run: 12 km → 10 km
Reason: Thursday basketball load was higher than planned
Scope: This week only
Changed by: External LLM
```

必须表达：

- 修改前。
- 修改后。
- 原因。
- 影响范围。
- 调整者。

### 13.3 视觉状态

- `Adapted` 使用轻量 badge，不把 session 标成 warning。
- 需要用户确认的建议使用 `Review` 状态，与已经生效的 `Adapted` 区分。
- 用户手动移动使用 `Moved`。
- 跳过使用 `Skipped`，不归类为 adaptation。
- 点击状态 badge 打开对应解释。

### 13.4 变化历史

Plan 页提供次级入口 `View change history`，以时间线展示重要变化。默认不占据三层主要信息架构。

时间线条目只显示用户可理解的变化，不呈现系统内部信息或长篇原始内容。

## 14. 关键操作流程

### 14.1 查看当前计划

```text
进入 Plan
→ 先看到目标与当前 Week/Phase
→ 看到当前 Phase 高亮
→ 自动定位当前周
→ 浏览未来周标题
→ 点击 session
→ 在 Drawer 查看完整处方与原因
```

### 14.2 执行今天的训练

```text
进入 Overview
→ 查看 Today 的全部 session
→ 打开一个 session
→ 按处方训练
→ Add as a completed workout
→ 记录 actual / RPE（若可用）
→ 返回 Overview，其他同日 session 保持 planned
```

### 14.3 移动一次训练

```text
打开 Session Drawer
→ Move
→ 选择新日期
→ 查看与前后关键训练的间隔提示
→ 填写/选择原因
→ Confirm move
→ 周历在新日期显示 Moved 状态
```

如果操作会影响多个后续 session：

```text
Athria 提示局部移动不足以保持原计划逻辑
→ Keep this one-time move / Ask LLM to reschedule remaining plan
```

### 14.4 跳过一次训练

```text
打开 Session Drawer
→ Skip
→ 显示“不自动补课”说明
→ 选择原因
→ Confirm
→ Session 保留在原日期并显示 Skipped
→ 需要时加入 weekly review context
```

### 14.5 请求 LLM 调整剩余计划

```text
点击 Ask LLM to adjust remaining plan
→ Dashboard 准备当前目标、完成情况、用户调整和数据质量摘要
→ 外部 LLM 提出候选修改
→ Dashboard 展示变化摘要：哪些周、哪些 session、progression 如何变化
→ 用户确认
→ 新计划生效，已完成历史不变
```

## 15. 状态与边界场景

### 15.1 没有 Current Mesocycle

Plan 页面不先要求用户手工创建模板，而是显示：

```text
No current plan
Ask your connected AI Agent to create a plan using your profile and training history.

[How to ask your Agent]
[Browse templates]
```

Template 是次要入口，不能成为创建计划的强制第一步。

### 15.2 计划有内容但缺少结构化处方

- Session 仍可打开并显示 legacy notes。
- 明确标记 `Needs structured review`。
- 提供 `Ask LLM to convert this session` 或整份计划转换入口。
- 不丢失旧 notes，也不假装它已经结构化。

### 15.3 缺少强度基线

例如没有最大心率、阈值配速或 FTP：

- 显示已有的 RPE 或 talk test。
- 不显示空的 HR / pace / power 行。
- 可以显示轻量说明：`Heart-rate target unavailable; use RPE guidance.`
- 不阻止用户查看或执行其他完整内容。

### 15.4 计划已过期但有未处理 session

- 不自动将它们全部标记 skipped。
- Overview 显示 `Past sessions need review`。
- 用户可以逐个处理，或让 LLM 在 weekly review 中解释其影响。

### 15.5 计划版本刚变化

- 回到 Plan 时保持当前周位置。
- 顶部显示一次性 `Plan updated` 提示。
- 提供 `See what changed`。
- 变化摘要优先按 Week 和 session 描述，不使用内部版本号作为主要信息。

### 15.6 长周期与高密度计划

- 任意长度计划首次加载都只展开 §7.3 定义的一个定位周，其余周默认折叠并可逐周展开。
- 一天超过三个 session 使用 `+N more`。
- Progression 按 phase 分段或横向滚动。
- 不通过缩小字体解决密度问题。

### 15.7 一个 session 包含多个运动组件

例如跑步热身 + 下肢力量 + 有氧冷身：

- Calendar 只显示一个 session 标题，如 `Combined Strength`。
- Chip 可显示多个 domain icon。
- Drawer 按执行顺序展示 components。
- 完成状态属于整个 session；若需要 component 级完成，作为后续能力，不在首版增加复杂度。

## 16. 视觉与内容规范

### 16.1 颜色

建议每个 domain 使用稳定的辅助颜色，但同时提供文字或 icon。标准配色如下（唯一来源为 `apps/desktop/src/styles.css` 中的 `--domain-*` token，所有页面必须引用，不得另行定义）：

- Strength：绿色（solid `#10ad64`，ink `#099855`，soft `#e9f9f1`）。
- Endurance：蓝色（solid `#1478ee`，ink `#0f6ed9`，soft `#ebf4ff`）。
- Sport / Skill：橙色（solid `#f06425`，ink `#e45a1d`，soft `#fff2e9`）。
- Mind-body：玫红色（solid `#ec2483`，ink `#dc1470`，soft `#fff0f7`）。
- Recovery：紫色（solid `#704bf2`，ink `#6841e6`，soft `#f3efff`）。

颜色用于快速扫描，不代表强度。High intensity 不能简单用与 Endurance 相同的颜色深浅表达，以免混淆运动类型和训练强度。

### 16.2 标签

建议统一状态词：

- Current
- Key session
- Completed
- Skipped
- Moved
- Adapted
- Review
- Base template
- May change after review

不要为同一状态在不同页面使用不同词。

### 16.3 文案风格

- 先说用户需要做什么，再说专业解释。
- 用具体变化代替模糊描述，例如 `12 km → 10 km`，不要只写 `Volume reduced`。
- 区分 planned、actual 和 suggested。
- 不使用具有医疗保证意味的文案，如 `Safe`、`Injury-proof`。
- LLM 解释过长时先显示两到三句摘要，再允许展开全文。

### 16.4 可访问性

- 所有 session chip 可键盘操作。
- 当前周、当前 phase 和状态不能只靠颜色表达。
- Drawer 打开后正确管理焦点，关闭后返回触发元素。
- 周历在窄屏转为每周纵向 agenda，而不是强制七列小字。
- 图表/轨道必须提供文本值。

## 17. 移动端或窄窗口响应方式

虽然 Athria 当前是桌面 App，但窗口可能很窄。

宽屏：

```text
Mon | Tue | Wed | Thu | Fri | Sat | Sun
```

窄屏：

```text
W3 · Build
Mon  Rest
Tue  Easy Run
     Lower B
Wed  Upper A
Thu  Intervals
     Basketball
...
```

规则：

- 保持 Week 分组，不将所有日期混成无限列表。
- Session 点击仍打开详情层；窄屏可以使用全高 sheet 代替右侧 Drawer。
- Progression 使用可横向滚动的表格或按 metric 纵向展开。
- Target 中次要信息折叠，但 Primary Goal 和当前位置始终可见。

## 18. 建议的页面组件清单

该清单描述产品组件，不限定技术实现：

- Mesocycle Target Card。
- Coordination Strategy Summary。
- Progression by Domain。
- Weekly Calendar Section。
- Week Header / Week Summary。
- Day Cell。
- Session Chip。
- Session Detail Drawer / Sheet。
- Prescription Step List。
- Repeat Group。
- Strength Exercise List。
- Progression Group。
- Progression Metric Track。
- Adaptive Change Callout。
- Change History Timeline。
- Weekly Review Prompt。
- Empty Plan State。
- Legacy Structured Review State。

## 19. 分阶段交付建议

当前交付范围止于 P1。P0 与 P1 是本阶段的实施和发布范围；P2 保留为后续设计，状态为 **Deferred**，本阶段不实现或验收。

### P0：让统一计划可读、可执行

- Mesocycle Target。
- Current Progression by Domain。
- 全周期 Weekly Calendar。
- Session Detail Drawer。
- Strength 与 Endurance 完整处方展示。
- Base Template 标识。
- Overview 的 Today / Next Training Day。

### P1：让 progression 和混合运动协调可理解

- Domain-specific progression strategy。
- Coordination Strategy。
- 周级分运动摘要。
- Ball sport、Recovery 与 combined session 展示。
- Flexible / Interval rhythm 的补充说明。

### P2（Deferred）：让调整可解释、可追溯

- 四级调整入口。
- Weekly Review prompt。
- Adaptive Change before/after。
- Change History。
- 大范围 LLM 候选计划变化摘要。

## 20. 体验验收标准

### 20.1 Plan 页

- 用户进入 Plan 后，不打开其他页面就能知道主目标、当前 Week 和当前 Phase。
- 当前 Phase 自动高亮，无需点击。
- Calendar 首次加载只展开一个定位周：活跃计划为当前周、未来计划为 Week 1、已结束计划为最后一周；其余周默认折叠。
- 用户可以逐周展开多个周，但界面不存在全局展开或折叠按钮。
- 点击任一 domain phase 会展开并定位到其第一周，不隐藏或折叠其他周。
- 用户能在一个周历里查看整个 Mesocycle 的所有运动。
- Calendar 中默认只显示 session 标题，不被完整处方淹没。
- 同一天能清楚展示多个 session。
- 点击任意 session 可在侧边查看完整处方。
- 有 Base Template 时明确显示；没有时不显示空状态。
- Progression 按运动分别展示，并与全周期 Week 轴对齐。
- 结构化 progression 不完整时，LLM notes 仍能作为补充呈现。

### 20.2 Rhythm

- Fixed、Flexible、Interval 三种计划都使用同一 Weekly Calendar。
- Flexible 计划显示当前建议日期和可移动性，而不是另一套孤立列表。
- Interval 计划能补充显示序列与间隔，但仍落在真实日期上。
- 用户移动 interval session 时，不会在不知情的情况下自动移动全部后续训练。

### 20.3 后续调整能力（P2 Deferred，不纳入当前发布验收）

以下条目保留为后续产品方向，不作为 P0–P1 的完成或发布门槛：完成、跳过、移动和 Adaptive Change 的完整状态模型；before/after/reason/scope/actor；多周重建与 LLM 候选方案审批。

### 20.4 处方

- 跑步 interval 可清楚展示 warm-up、repeat work/recovery 和 cooldown。
- 缺少心率或配速基线时，不虚构目标，仍能用 RPE 或 talk test 展示。
- 力量训练可显示动作、组次、RPE、休息和其他已提供信息。
- 球类和恢复训练不再只能显示一个总时长与 notes。

## 21. 完整体验示例

用户有一个 10 周 10K 主目标计划，同时每周进行两次力量训练和一次篮球。

进入 Plan 后，顶部显示：

```text
Primary: 10K < 50:00
Supporting: Strength 2×/week
Maintenance: Basketball 1×/week
Constraint: At most 5 training days
Coordination: Basketball counts as a high-intensity stimulus
```

每条 domain timeline 自动高亮 Week 4 各自所属的 phase。

Weekly Plan 直接展示全部 10 周。Week 4 为：

```text
Mon       Tue                Wed       Thu                 Fri     Sat       Sun
Rest      Easy Run           Upper A   Intervals           Rest    Lower A   Long Run
          35 min                       Basketball
```

用户点击 `Intervals`，右侧打开：

```text
Purpose: 10K-specific aerobic development
Base template: Running · Intervals

10 min Easy
6 × [800 m @ target pace + 2 min Easy jog]
10 min Easy

This week: one more repetition than Week 3
Why Thursday: separated from Sunday long run and Saturday lower-body strength
```

在 Progression by Domain 中，用户看到 Running、Strength 和 Basketball 各自的阶段轨道。具体周度变化来自 Weekly Session prescription 和 progression note，不被塞进跨领域的统一指标。

周四篮球实际强度高于计划。Weekly Review 后，LLM 建议把周日长跑从 12 km 调整为 10 km。用户确认后：

- Week 4 标记 `Adapted`。
- Long Run chip 标记 `Adapted`。
- Drawer 显示 `12 km → 10 km`、原因、影响仅本周、调整者为 External LLM。
- 其他未来周保持原计划，除非 LLM 明确说明也被修改。

这就是最终体验应达到的状态：用户看到的不是拼接在一起的有氧计划与无氧计划，而是一份有目标、有阶段、有全周期周历、有具体处方、有 progression、也能解释变化的统一训练计划。
