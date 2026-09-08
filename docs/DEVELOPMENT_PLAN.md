# Athria 项目开发文档

> 状态：正式架构方案  
> 文档版本：1.1  
> 日期：2026-09-02  
> 目标读者：产品负责人、训练领域专家、软件开发与测试人员

## 1. 项目概述

Athria 是一套 **local-first 的智能训练基础设施**。它在用户设备上保存训练资料，提供可计算、可测试的训练科学能力，并允许 AI Agent 通过工具读取状态、编排训练计划和解释决策。

Athria 的核心定位是：

> **Athria Core 是可计算、可测试的训练科学与数据层；AI Agent 是训练策略与计划编排层。**

完整计划不一定由 Core 生成。外部 MCP Agent 或未来的 Athria 内置 Agent 可以结合专门的训练 Skill 制定和调整计划，再由 Core 校验并在用户批准后保存。

项目分两个阶段：

1. **MCP MVP：** 提供基础 Dashboard、Core、SQLite、MCP Server、安装包和配套训练规划 Skill；AI 由用户现有的 MCP Agent 提供。
2. **最终架构：** 在同一套 Core 和工具接口上加入内置 AI Agent，使用用户自己的模型 API key。

当前仓库采用本文档定义的 TypeScript/Tauri 架构；Schema、真实数据 fixture、规则案例和 golden outputs 作为持续回归测试基线。

### 1.1 Athria 0.2 / Plan Schema v3 架构更新

Plan Schema v3 以开放动作和多 component 取代“动作枚举 + 单一 modality”。Session 不持久化 modality；界面和 API 从 `components[].domain.value` 去重派生 `domains[]`。`mixed` 仅可作为历史采集元数据存在，不属于计划 taxonomy。

Strength 动作使用稳定 ID、显示名、可空 canonical key，以及带来源、置信度、依据和 taxonomy 版本的分类事实。目录命中不是计划合法性的前提。Core 按 component domain 分派规则包，并在规则级返回 `pass | fail | unknown | not_applicable`；只有 blocker 的 `fail` 或 `unknown` 阻止批准。自然语言 `constraintNotes` 不由 Core 宣称执行。

当前科学规则包仅覆盖 Strength。Endurance、Sport skill、Mind-body 与 Recovery 先通过 duration-only component 承载。数据库 migration v4 在事务中备份并转换 v2 草稿、版本、排程和变更快照；需要人工复核的迁移版本在重新批准前不能驱动排程。本节在术语、Schema 和裁决模型上覆盖下文仍保留的 MVP v2 描述。

## 2. 用户与目标

### 2.1 目标用户

- 希望长期保存和管理训练资料的个人用户；
- 希望使用 Claude、Codex 等外部 Agent 规划训练的用户；
- 希望直接在 Athria 中使用 AI Coach 的非技术用户；
- 希望基于标准接口开发训练 Agent 或 Skill 的开发者。

### 2.2 用户要完成的工作

- 在本地统一保存 Profile、训练记录、训练状态和计划历史；
- 获得可信、可复现的训练指标与规则校验；
- 让 AI 理解自然语言需求并编排训练计划；
- 在保存计划或修改长期资料前查看差异并确认；
- 不依赖 Athria 云服务器即可备份、迁移和继续使用数据。

### 2.3 成功定义

MVP 的核心成功标准是：用户安装 Athria 后，可以让外部 MCP Agent 完成“读取状态 → 使用 Skill 编排计划 → Core 校验 → Agent 修订 → 用户批准 → 保存版本”的闭环。

最终版本的核心成功标准是：相同闭环可以由 Athria 内置 Agent 完成，并且内置 Agent 与外部 Agent 共用同一套工具、Schema、校验与审批规则。

## 3. 设计原则

### 3.1 Local-first

- 训练数据、Profile、计划、Memory 和配置默认保存在本机；
- Athria 不要求账号、云数据库或 Athria 托管服务器；
- 用户可以导出、备份并迁移自己的数据；
- 外部网络访问必须由用户主动配置的数据源或 AI Provider 触发。

### 3.2 Core 与 Agent 分离

- Core 只处理可确定、可计算、可测试的训练状态与规则；
- Agent 负责理解、策略选择、计划编排和解释；
- Core 不依赖任何 LLM、Provider 或 Skill；
- Agent 不能绕过 Core validation 或用户审批。

### 3.3 单一工具边界

Dashboard、MCP 和内置 Agent 必须调用同一 application service。业务写入不能绕过 Zod Schema、权限检查、Core validation 和审批状态直接操作 SQLite。

### 3.4 版本化与可追溯

- 训练规则、Skill、计划和数据迁移均有版本；
- 每次正式计划变化创建新版本，不覆盖历史版本；
- 计划应记录来源 Agent、模型、Skill、输入约束、校验结果和批准时间；
- 恢复旧计划也创建一个新版本，从而保留完整历史。

### 3.5 明确数据不足

Core 和 Agent 不得把缺失数据解释为正常或已恢复。数据不足时必须返回结构化缺口，并说明哪些判断无法可靠完成。

## 4. 总体架构

### 4.1 MCP MVP

```text
┌──────────────────────────────────────────────┐
│              Athria Desktop                  │
│                                              │
│  React Dashboard                             │
│       │                                      │
│       ▼                                      │
│  Local Application Service                   │
│       ├── Athria Core                        │
│       ├── Data / Import / Backup              │
│       └── MCP Server                         │
│                 │                            │
│                 ▼                            │
│              SQLite                          │
└───────────────────┬──────────────────────────┘
                    │ MCP
                    ▼
           External Agent + Skill
        Claude / Codex / other MCP host
```

MVP 中 Athria 不调用 LLM。模型选择、模型费用和 Agent 运行环境由外部 MCP Host 负责。

### 4.2 最终架构

```text
Athria Dashboard / Chat
          │
          ▼
  Internal Agent Runtime ─── AI Provider
          │                   user's API key
          ├── Skill Loader
          ├── Context Builder
          ├── Tool Orchestrator
          └── Approval Flow
          │
          ▼
     Athria Tool API
          │
          ▼
      Athria Core
          │
          ▼
Profile / Training State / Plans / Memory / SQLite

External Agent ───── MCP ───────────────┘
```

内置与外部 Agent 使用相同的 `AthriaTool` 定义。区别只在于 Agent Runtime 位于 Athria 内部还是第三方 MCP Host 中。

### 4.3 依赖方向

```text
Dashboard ─┐
MCP ───────┼──> Application Service ──┬──> Core
Agent ─────┘                          └──> Repository Interface ──> SQLite Adapter

Skill ──> Agent
AI Provider ──> Agent
```

禁止反向依赖：Core 不导入 Dashboard、MCP、Agent、Skill、SQLite Driver 或 Provider SDK。

## 5. Athria Core 的职责

### 5.1 Core 的纯计算边界

Core 定义标准化训练领域模型，接收不可变的 Profile、训练记录、计划和规则配置，并返回派生状态、指标、progression evaluation 或 validation result。Core 不读取或写入数据库，也不处理审批、事务和计划版本创建。

职责按层划分如下：

- **Core：** 领域模型、状态派生、指标计算、progression evaluation、单次训练与计划校验；
- **Data/Repository：** Profile、训练记录、动作目录、草稿和正式计划版本的持久化；
- **Application Service：** 用例编排、Schema validation、审批、事务，以及不可变计划版本的创建；
- **Agent/Skill：** 用户意图理解、训练策略、计划编排、动作选择和自然语言解释。

Application Service 只有在确认审批有效、Schema validation 通过且 Core validation 通过后，才能通过 Repository 创建不可变计划版本。

每项 Core 规则必须满足：输入与输出明确、无隐藏 I/O、相同版本下结果可复现、边界条件可测试、默认阈值有来源或明确标记为启发式。

Core v0.1 面向一般健康成人的训练记录和计划辅助，不覆盖医疗、康复或伤病治疗。

### 5.2 Core v0.1 模块

#### Exercise Engine

- 定义动作、主要与次要肌群、运动模式、器械、单/双侧等标准标签；
- 按器械、动作标签和用户明确限制筛选候选动作；
- 返回候选、匹配依据和排除原因；
- 不决定最终采用哪个动作，最终选择属于 Agent 或用户。

#### Strength Engine

- 计算 sets、reps、load、原始 volume、PR 和周肌群训练量；
- 计算带公式版本的 e1RM，但不把估算值描述为真实 1RM；
- 评估可配置的 double progression；
- 仅在存在有效 RPE/RIR 输入时评估基础 autoregulation；
- 区分直接 sets、间接参与和原始 volume，不合并为单一“有效训练量真相”。

#### Endurance Engine

- 计算 duration、distance、pace、heart rate、time-in-zone、功率和分项目周训练量；
- 心率区间必须记录 max HR、LTHR 或其他基准的来源和计算方法；
- Strength 与 Endurance 指标分别计算，不合并为未经验证的综合训练负荷；
- MVP 不实现 Critical Power、W′、Banister、PMC 或统一“疲劳分数”。

[GoldenCheetah](https://github.com/GoldenCheetah/GoldenCheetah) 可用于研究耐力指标分层、公式组织和验证方式；其 GPL-2.0 代码不能在未完成许可证评估的情况下复制到 Athria。

#### Constraint Engine

- 检查可训练时间、器械、可训练日、频率、重复或时间冲突、明确恢复间隔和用户自定义上下限；
- 结果分为 `hard`、`soft` 和 `info`；
- 只有客观冲突、结构错误和用户明确限制可以默认成为 `hard`；
- 训练科学建议默认属于 `soft` 或 `info`，不得仅凭启发式阈值阻止保存；
- 恢复只做明确规则检查或返回已有证据，不计算伪精确的“恢复百分比”。

### 5.3 指标与规则的可追溯性

每个指标必须返回：

- 数值和单位；
- 计算方法及公式版本；
- 输入时间范围与数据来源；
- 输入完整度、缺失字段和异常项；
- 适用条件与已知限制。

RPE/RIR 属于主观输入，缺失时不得推断。文档和 UI 使用“结构与已配置规则合规性验证”，不使用暗示医学安全认证的“合法性验证”。

Core v0.1 优先采用简单、渐进、可测量且能被测试的规则，不把仍有争议的训练处方变量固化为唯一答案。训练原则与默认值应参考 [2026 ACSM resistance-training position stand](https://pubmed.ncbi.nlm.nih.gov/41843416/)，但产品规则仍需记录适用人群、证据来源和版本。

### 5.4 Progression 状态机

```text
Explicit Prescription
+ Previous Training State
+ Completed Workout Event
+ Progression Policy Version
→ Progression Evaluation
→ Proposed Next Prescription
```

Progression 规则只评估已有 prescription，不自由设计训练。它必须区分成功、部分完成、失败、缺失记录和异常值，考虑器械最小增量与单位换算，并返回建议变化、触发条件、reason code 和置信限制。

Progression evaluation 不修改计划或训练记录。Agent 或用户可以把建议应用到草稿，再由 Core 重新验证。Double progression 是可配置策略，不是所有动作、目标或用户的默认规则。[wger 的 progression rules](https://github.com/wger-project/docs/blob/master/docs/manual/routines.rst) 可作为条件—动作式规则设计参考，但复制代码前必须单独评估许可证兼容性。

### 5.5 Core 不负责的能力

- 像教练一样自由生成整套训练方案；
- 设计复杂周期或决定阶段目标；
- 根据旅行、工作、疲劳等信息制定整体策略；
- 自主选择动作或决定替代动作；
- 对复杂恢复状态作开放式判断；
- 生成面向用户的长篇自然语言解释。

Core 可以返回“哪些规则未满足”“输入证据是什么”和“哪些字段允许调整”，但最终采用哪种策略由 Agent 或用户决定。

### 5.6 无 AI 时的能力

未连接外部 Agent、未配置 API key 或 Provider 不可用时，用户仍然可以：

- 查看和编辑 Profile；
- 导入与浏览训练记录；
- 查看训练指标和状态；
- 执行基础 progression 计算；
- 手工创建或修改计划；
- 验证、比较、批准和恢复计划。

离线模式不自动生成完整计划。

## 6. Agent 与 Skill 的职责

### 6.1 Agent 负责的能力

- 理解用户目标和自然语言限制；
- 从 Core 按需读取结构化状态，避免把整个数据库塞入 prompt；
- 选择适合的 Skill 和训练策略；
- 决定周期结构、训练安排、动作和替代方案；
- 生成或修改完整计划草稿；
- 调用 Core validation，并根据结果迭代草稿；
- 解释建议、风险、数据缺口和计划变化；
- 请求用户批准计划或 Profile 修改；
- 通过受控工具写回批准后的结果。

### 6.2 标准 Agent 工作流

```text
用户需求
   │
   ▼
Agent + Training Skill
   │
   ├── 读取 Profile、Preference、训练状态和动作目录
   ├── 识别缺失数据并按需向用户提问
   ├── 调用 Core 计算指标
   ├── 选择策略并编排计划
   ├── 调用 Core 验证
   ├── 根据违规结果修订
   ├── 展示差异、理由和不确定性
   └── 请求用户批准
              │
              ▼
       保存计划新版本
```

### 6.3 Skill 边界

Skill 是提供给 Agent 的版本化训练方法，不属于 Core：

```text
skills/
├─ athria-training-planner/
├─ hypertrophy-planning/
├─ strength-progression/
├─ endurance-base/
├─ concurrent-training/
├─ travel-week-adjustment/
└─ deload-review/
```

每个 `AgentSkillManifest` 至少声明：

| 字段 | 含义 |
|---|---|
| `name` / `version` | 唯一名称与版本 |
| `purpose` | Skill 解决的问题 |
| `appliesWhen` | 适用条件 |
| `doesNotApplyWhen` | 不适用条件 |
| `requiredContext` | 需要从 Core 获取的数据 |
| `allowedTools` | 允许调用的 Athria tools |
| `workflow` | 规划与校验步骤 |
| `outputSchema` | 结构化输出格式 |
| `approvalPoints` | 必须由用户确认的决策 |
| `safetyRules` | 安全限制及数据不足处理 |

Skill 可以提出策略，但不能扩大工具权限、直接写数据库、跳过 validation 或代替用户批准。

## 7. 技术栈

| 层 | 技术 | 主要职责 |
|---|---|---|
| Monorepo | pnpm workspace | 管理 apps 与 packages |
| Desktop shell | Tauri 2 | 窗口、sidecar、系统能力和安装包 |
| Native layer | Rust | 生命周期、密钥库、文件权限、更新 |
| Dashboard | React + TypeScript + Vite | 本地交互界面 |
| Server state | TanStack Query | 请求、缓存和错误状态 |
| Local service | TypeScript + Bun executable | Application Service、Core、MCP |
| Database | SQLite + WAL | 单用户本地持久化 |
| Data access | Drizzle ORM + migrations | 类型化查询与 Schema 演进 |
| Runtime schema | Zod + JSON Schema | UI、MCP、Agent 和 Core 共用契约 |
| MCP | Official TypeScript SDK | stdio 与 Streamable HTTP |
| Unit tests | Vitest | Core、Schema、application service |
| UI tests | React Testing Library | 组件和交互 |
| End-to-end | Playwright | Dashboard 与桌面主流程 |
| Secrets | OS Credential Manager / Keychain | 保存 API key 和本地令牌 |
| AI provider | `AiProvider` interface | OpenAI 首发，后续扩展其他 Provider |

Tauri 的 Rust 层保持轻薄，不承载训练业务逻辑。TypeScript sidecar 由 Tauri 启动，也可以被外部 MCP Host 以 stdio 模式单独启动。Tauri 支持随应用嵌入外部二进制；Bun 支持把 TypeScript 编译为跨平台独立可执行文件；官方 MCP TypeScript SDK 支持 stdio 与 Streamable HTTP。

参考资料：

- [Tauri 2：Embedding External Binaries](https://v2.tauri.app/develop/sidecar/)
- [Bun：Single-file executable](https://bun.sh/docs/bundler/executables)
- [Bun：SQLite](https://bun.sh/docs/runtime/sqlite)
- [MCP TypeScript SDK：Server Guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)

🔶 **假设：** Bun 编译产物与所选 MCP、SQLite 依赖在所有目标平台上兼容。正式重写前必须用 Windows x64、macOS arm64 和 Linux x64 完成打包 spike。

## 8. 建议的 Monorepo 结构

```text
athria/
├─ apps/
│  ├─ desktop/                 # Tauri + React Dashboard
│  └─ service/                 # Bun sidecar 入口
├─ packages/
│  ├─ schemas/                 # Zod 与 JSON Schema
│  ├─ core/                    # 指标、progression、约束、validation
│  ├─ application/             # 用例、审批与事务边界
│  ├─ data/                    # SQLite、Drizzle、migration、backup
│  ├─ integrations/            # Hevy、Intervals 等 adapter
│  ├─ mcp/                     # MCP server 与 tools
│  ├─ agent/                   # 最终阶段的内置 Agent Runtime
│  ├─ ai-providers/            # Provider adapters
│  └─ skills/                  # 官方训练 Skill
└─ tests/
   ├─ fixtures/
   ├─ golden/
   └─ e2e/
```

`agent` 和 `ai-providers` 在 MCP MVP 中只保留接口或不创建实现，避免提前引入内置 LLM 复杂度。

## 9. 公共接口与数据类型

以下类型由 `packages/schemas` 定义，供 Dashboard、MCP、Agent 和 application service 共用：

| 类型 | 用途 |
|---|---|
| `AthleteProfile` | 稳定且已确认的用户事实 |
| `TrainingPreference` | 可调整的训练偏好 |
| `AgentMemory` | 动态、带来源的 Agent 上下文 |
| `ExerciseDefinition` | 标准动作、器械和分类 |
| `TrainingSession` | 已完成的训练记录 |
| `TrainingStateSnapshot` | 指定时间点从历史与 Profile 派生的不可变状态 |
| `TrainingMetrics` | 按 Strength/Endurance 分组的指标集合 |
| `MetricResult<T>` | 值、单位、方法、版本、输入覆盖率和限制 |
| `DataQuality` | 完整度、来源、缺失字段和异常项 |
| `RuleResult` | severity、reasonCode、messageArgs、evidence 和 ruleVersion |
| `ProgressionInput` | 基础 progression 计算输入 |
| `ProgressionEvaluation` | 当前 prescription、表现结果、建议变化和原因 |
| `ExerciseCandidate` | 标准动作、器械要求、标签匹配和排除原因 |
| `TrainingPlanDraft` | 用户或 Agent 创建的未批准计划 |
| `PlanValidation` | 整体校验结果与数据缺口 |
| `ConstraintViolation` | 单项 hard/soft/info 规则结果 |
| `TrainingPlanVersion` | 不可变的正式计划版本 |
| `ProfileUpdateProposal` | 待用户确认的 Profile 修改 |
| `AgentSkillManifest` | Skill 能力、流程和权限声明 |
| `AiProvider` | 内置模型 Provider 接口 |
| `AthriaTool` | UI、MCP 和 Agent 共用工具定义 |

Schema 变更遵循以下规则：

- 持久化结构变化必须包含 migration；
- MCP 输入输出变化必须更新 JSON Schema 和 contract tests；
- 新字段优先保持向后兼容；
- 指标结果必须包含单位、方法、公式版本和 `DataQuality`；
- 规则结果必须包含 `ruleVersion`、稳定的 `reasonCode` 和输入 evidence；
- 计划版本必须记录 `skillVersion`，未使用 Skill 时明确为 `null`。

## 10. Profile、Preference、Memory 与计划版本

### 10.1 Profile

Profile 保存稳定、明确且经过用户确认的事实，例如目标、经验水平、长期频率、器械、固定时间限制和训练限制。Agent 只能创建 `ProfileUpdateProposal`，不能直接修改 Profile。

### 10.2 Preference

Preference 保存动作喜好、训练时长、常用训练日和替代偏好。Preference 的修改仍需通过 application service，但可以采用比 Profile 更轻量的确认流程。

### 10.3 Agent Memory

Memory 保存临时行程、近期主观反馈、阶段性策略，以及 Agent 观察到但尚未确认为 Profile 的信息。每条 Memory 至少包含：

- 来源和原始依据；
- 创建时间与创建 Agent；
- 置信度；
- 有效期或复核时间；
- 与 Profile 是否冲突。

Memory 不得自动覆盖 Profile。过期 Memory 默认不进入 Agent 上下文。

### 10.4 Current Mesocycle and Session Template Library

当前实现不再保存 Plan Draft、Approval 或不可变 Plan Version。每位用户维护：

- 独立的 `session_templates` 最新状态，支持创建、编辑、复用和受引用保护的删除；
- 单行 `current_mesocycles` 最新状态，Weekly Structure 仅引用同一用户的 template ID；
- 用于并发检测的 `revision`，但不以此保存历史版本；
- 独立的 dated planned-session 快照，完成、跳过及 legacy 快照不会被计划编辑改写。

Dashboard 与 MCP 都可直接保存最新计划，保存前运行完整 Core 校验。Profile proposal 的审批边界保持不变。

## 11. 阶段一：MCP MVP

### 11.1 范围

MVP 交付：

- Windows、macOS、Linux 桌面安装包；
- 基础 Dashboard；
- 本地 SQLite 数据库、migration、备份和恢复；
- Hevy、Intervals 等第一批数据 adapter；
- Core 指标、基础 progression、约束和 validation；
- stdio 与本地 Streamable HTTP MCP；
- provider-neutral 的 `athria-training-planner` Skill；
- 计划差异、审批、版本和恢复。

MVP 不包含：

- Athria 内置聊天或 LLM；
- Athria 账号、同步服务或云数据库；
- 自动写回第三方训练平台；
- 完整计划的 Core 自动生成器；
- iOS 或 Android 安装包。

### 11.2 Dashboard

基础 Dashboard 包含：

- Setup 与 Athlete Profile；
- 数据导入、连接和同步状态；
- 训练历史、指标和当前训练状态；
- 当前 Mesocycle 与嵌套的 Session Template Library；
- 直接编辑、validation 结果和未来排期影响选择；
- 手工创建或编辑计划；
- Profile、Preference、备份和 MCP 状态。

### 11.3 MCP Tools

#### 读取状态

- `get_athlete_profile`
- `get_training_state`
- `list_training_sessions`
- `get_training_summary`
- `get_current_plan`
- `list_session_templates`
- `get_session_template`
- `get_exercise_catalog`

#### 确定性计算

- `calculate_training_metrics`
- `estimate_1rm`
- `calculate_heart_rate_zones`
- `evaluate_double_progression`
- `evaluate_rpe_autoregulation`
- `evaluate_progression`
- `find_exercise_candidates`

#### 计划验证

- `validate_workout`
- `validate_plan`
- `check_training_constraints`
- `preview_session_template_change`
- `validate_current_plan`
- `explain_validation_result`

#### 受控写入

- `create_session_template`
- `update_session_template`
- `delete_session_template`
- `save_current_plan`
- `propose_profile_update`
- `commit_approved_profile_update`

`calculate_training_metrics` 按 Strength/Endurance 返回 `MetricResult`，不产生单一综合训练分数。读取、计算、候选筛选和 validation 工具不得修改状态。模板与计划写入必须验证 Schema、owner、revision、最新输入快照和 Core blocker；计划无需审批即可成为当前版本。

不提供任意 SQL、任意文件读取、密钥访问、数据库删除或跳过 validation 的写入能力。

### 11.4 MVP 配套 Skill

`athria-training-planner` 指导外部 Agent：

1. 查询 Profile、Preference 和训练状态；
2. 识别缺失信息，必要时询问用户；
3. 选择训练策略；
4. 创建符合 `TrainingPlanDraft` 的草稿；
5. 调用 Core validation；
6. 根据违规结果修订，直至无 hard violation 或明确停止；
7. 展示计划差异、理由、不确定性和数据缺口；
8. 获得批准后提交正式版本。

Skill 不包含用户私有数据，不绑定 OpenAI、Anthropic 或特定 MCP Host。

## 12. 阶段二：内置 AI Fitness Agent

### 12.1 新增能力

- Dashboard Chat；
- Provider 选择、API key 设置和连接测试；
- Skill Loader 与 Skill 版本记录；
- 按需 Context Builder；
- Tool Orchestrator；
- 结构化输出校验；
- validation 失败后的计划迭代；
- 流式响应、取消、超时、限流和重试；
- Memory 管理；
- 计划和 Profile 审批流程。

### 12.2 Provider 接口

`AiProvider` 只暴露 Agent 所需的通用能力，例如模型列表、结构化消息、工具调用、流式响应、取消和错误分类。首个实现为 OpenAI adapter；Anthropic 和 Gemini 作为后续 adapter。

Provider-specific request、response 和错误类型不得进入 Core、公共 Schema 或数据库模型。

### 12.3 API key 安全

- API key 只存入操作系统密钥库；
- SQLite 仅保存 Provider、模型和 secret reference；
- key 不进入前端持久化、日志、诊断包或备份；
- sidecar 只在需要调用 Provider 时获得短生命周期凭据；
- 删除 Provider 配置时同时删除对应密钥。

🔵 **开放问题：** Tauri 主进程向 Bun sidecar 传递短生命周期凭据的最终 IPC 方式，需要在 Agent 阶段开始前完成 threat model 和 spike。

## 13. 模块与团队分工

| 角色/模块 | 主要职责 | 主要交付物 |
|---|---|---|
| Training Domain | 指标、progression、约束、reason codes | 规则说明、阈值依据、golden cases |
| Core Engineering | 确定性计算、状态派生、validation | `packages/core` 与单元测试 |
| Data Engineering | SQLite、migration、导入、版本、备份 | `packages/data` 与恢复测试 |
| MCP/Platform | tools、sidecar、Tauri、安装和本地安全 | MCP server、安装包、诊断 |
| Frontend | Dashboard、差异、校验和审批 UI | `apps/desktop` 与 UI 测试 |
| Skill Engineering | 规划 Skill 的编写和评估 | Skill、样例、评估案例 |
| Agent/AI | Context、Provider、工具循环、Memory | `packages/agent` 与 provider adapters |
| QA/Release | golden、跨平台、安全、性能和恢复 | CI、测试报告、发布清单 |

单人开发按以下顺序承担角色：

```text
Schema → Core → Data → MCP → 基础 Skill → Dashboard → Packaging → 内置 Agent
```

## 14. 建议开发阶段

### Phase 0：架构 Spike

- 验证 Bun sidecar 在三个桌面目标上的编译与 Tauri 打包；
- 验证同一 service binary 的 `serve`、`mcp --stdio` 两种入口；
- 验证 SQLite 并发、WAL、migration、备份和恢复；
- 在 TypeScript 测试中重放冻结的 golden cases。

**退出标准：** 三个平台均能启动 sidecar，Dashboard 与 MCP 可以读取同一测试数据库。

### Phase 1：Schema、Core 与 Data

- 建立 monorepo、共享 Schema 和数据库 migration；
- 完成训练记录、Profile、Preference、动作目录和计划版本；
- 完成 Exercise、Strength、Endurance 和 Constraint 四个 Core vertical slice；
- 完成首批可追溯指标、progression evaluation 和 constraint validation；
- 迁移原型 fixture 和 golden tests。

**退出标准：** 相同输入在相同公式与规则版本下产生稳定结果；Core 无隐藏 I/O，不依赖数据库实现或 Agent；指标结果包含方法、单位、输入质量与限制。

### Phase 2：MCP Vertical Slice

- 实现读取、计算、validation 和审批写入工具；
- 完成 stdio 与本地 Streamable HTTP；
- 编写 `athria-training-planner` Skill；
- 用至少一个外部 MCP Host 跑通完整流程。

**退出标准：** Agent 可以创建、修订并在批准后保存一个通过结构与已配置规则合规性验证的计划版本。

### Phase 3：Dashboard 与安装包

- 完成 Setup、Profile、Timeline、State、Plan、Approval 和 Backup 页面；
- 完成 Tauri lifecycle、sidecar 健康检查和诊断；
- 构建 Windows、macOS、Linux 安装包。

**退出标准：** 无开发环境的新设备可以安装、导入数据、连接 Agent、批准计划并完成恢复。

### Phase 4：内置 Agent

- 实现 Provider、Chat、Skill Loader、Context、Memory 和工具循环；
- 加入流式交互、错误恢复和审批；
- 验证与外部 Agent 的工具和结果一致性。

**退出标准：** 配置用户 API key 后，内置 Agent 能完成与 MCP Agent 相同的闭环。

## 15. 测试与验收

### 15.1 Core

- [ ] 使用手算基线验证 e1RM、volume、pace、time-in-zone 和 progression。
- [ ] 相同输入、公式版本和规则版本始终产生相同指标与 validation 结果。
- [ ] e1RM、心率区间和训练量计算覆盖正常值、边界值、异常值和缺失值。
- [ ] Strength 与 Endurance 指标分组返回，不生成未经验证的综合负荷分数。
- [ ] 指标结果包含数值、单位、方法版本、输入范围、数据质量和限制。
- [ ] double progression 与 RPE/RIR autoregulation 明确拒绝不适用或信息不足的输入。
- [ ] progression 覆盖成功、部分完成、失败、连续失败、器械无法满足增量和数据缺失。
- [ ] 测试 kg/lb、时区、跨周边界、重复记录和缺失 RPE/RIR。
- [ ] property tests 验证非负训练量、单位转换可逆、重复导入幂等和输入状态不可变。
- [ ] Constraint Engine 正确区分 hard/soft/info，soft 与 info 不能阻止保存。
- [ ] Core 对复杂策略只返回数据和规则结果，不生成完整计划。
- [ ] 缺失恢复数据时返回明确缺口，不推断用户已恢复。
- [ ] 所有 hard violation 均阻止计划成为正式版本。
- [ ] Golden tests 记录人工基线或公开公式依据，而不是只复制当前实现输出。

### 15.2 Core POC 阶段门

至少一个 Strength vertical slice 和一个 Endurance metrics slice 必须同时通过：

- 手算或独立实现基线；
- 正常样例、边界样例和失败样例；
- 外部 Agent 工具调用；
- 相同输入与版本的可重复性测试。

在满足上述条件前，不扩展 Critical Power、W′、Banister、PMC、MEV/MAV/MRV、CNS fatigue、恢复百分比或复杂周期逻辑。

### 15.3 MCP MVP

- [ ] 外部 Agent 能完成“读取—编排—验证—修订—解释—审批—保存”。
- [ ] Dashboard 与 MCP 对同一请求返回一致的核心数据。
- [ ] 无 Agent 时仍能查看指标、编辑并验证计划。
- [ ] MCP 无法读取密钥、执行任意查询或绕过审批。
- [ ] 未通过结构或 hard rules 的计划不能提交为正式版本。
- [ ] 矛盾约束、未知动作和恶意 Agent 输入会被 Schema 或 Core validation 明确拒绝。
- [ ] 重复导入不会产生重复记录。
- [ ] 备份可以在新的空数据目录中完整恢复。
- [ ] sidecar 崩溃、端口冲突、数据库锁定和 migration 失败均有可操作提示。
- [ ] Windows、macOS、Linux 安装包无需另装 Node、Bun、Python 或数据库。

### 15.4 内置 Agent

- [ ] 内置和外部 Agent 使用相同 tools、Schema 和 validation。
- [ ] Skill 版本随计划版本保存。
- [ ] Agent 能根据 Core 违规结果迭代或明确停止。
- [ ] Profile 更新必须确认，Memory 不能直接修改 Profile。
- [ ] API key 不出现在 SQLite、日志、诊断包或备份中。
- [ ] 超时、限流、无效 key 和结构化输出错误不会破坏现有计划。
- [ ] 未配置 API key 时 Dashboard、Core 和 MCP 仍可使用。
- [ ] 恢复旧计划会创建新版本，不修改历史记录。

## 16. 性能与安全基线

- 常用 Dashboard 页面在 10,000 条训练 session 以内应于 2 秒内显示主要内容；
- 常用 Core 指标与单次计划 validation 应在本机 1 秒内完成；
- 本地 HTTP 只监听 `127.0.0.1`，验证 Host header，并使用随机本地令牌；
- stdio 的 stdout 只输出 MCP 协议消息，日志写入 stderr；
- importer 对文件大小、类型和解析耗时设置限制；
- migration 前自动备份，恢复操作要求目标目录为空；
- 诊断包默认脱敏，不包含完整健康数据、聊天内容或 secret；
- 所有外部内容和 Agent 输出均按不可信输入处理并执行 Schema validation。

## 17. 主要风险与缓解

| 风险 | 缓解措施 |
|---|---|
| TypeScript sidecar 增加跨平台打包复杂度 | Phase 0 先完成三个目标平台的打包 spike |
| Agent 给出不符合结构或已配置规则的计划 | Schema validation、hard constraints、审批和不可变版本 |
| Skill 与 Core 规则冲突 | Skill 只负责策略，Core validation 始终具有最终写入否决权 |
| Strength 与 Endurance 被压缩成伪精确综合分数 | 分项目计算，统一结果只保留并列指标和数据质量 |
| 恢复或疲劳规则被误认为确定事实 | 不计算恢复百分比；启发式建议只能为 soft/info |
| 公式或阈值变化使历史结果不可重放 | 指标、规则和 progression policy 全部记录版本 |
| 开源算法代码与 Athria 许可不兼容 | 先研究公式和架构；复制代码前完成逐项目许可证评估 |
| Profile 被聊天内容污染 | 只允许 `ProfileUpdateProposal`，Memory 与 Profile 分离 |
| Prompt 上下文持续膨胀 | Context Builder 按需查询结构化状态，Memory 设置有效期 |
| 多个入口形成不同业务逻辑 | UI、MCP 和 Agent 共用 application service 与 `AthriaTool` |
| Bun/MCP 依赖打包不兼容 | 固定版本、构建矩阵、安装 smoke test 和可替换 sidecar runtime 边界 |
| 训练阈值被误认为医学结论 | 标注来源与启发式性质，产品不提供诊断或伤病治疗建议 |
| 本地数据库损坏或 migration 失败 | WAL、迁移前备份、完整性检查和空目录恢复测试 |

## 18. 明确不在当前范围内

- Athria 账号、云同步、社交或多人协作；
- Athria 托管的模型代理或代付模型费用；
- 医疗诊断、伤病治疗或替代专业医疗建议；
- iOS、Android 正式交付；
- Core 自由生成完整训练计划；
- Critical Power、W′、Banister、PMC 和统一疲劳分数进入 Core MVP；
- MEV/MAV/MRV、CNS fatigue 或恢复百分比成为确定性 hard rule；
- 无审批的 Agent 自动修改 Profile 或正式计划；
- 为未来可能性提前拆分微服务或建设插件市场。

移动端仅预留 Schema、Core 和 React 组件复用边界。是否正式开发移动 App，应在桌面 MVP 验证后另行立项。

## 19. 已确认决策与开放问题

### 已确认

- 正式产品全面采用 TypeScript/Tauri；
- MVP 包含基础 Dashboard 和外部 Agent 配套 Skill；
- MVP 不包含内置聊天；
- Core 不提供完整计划生成器；
- 外部和内置 Agent 共用同一 Tool API；
- 产品保持 local-first、单机单用户；
- Windows、macOS、Linux 为桌面目标，手机端暂不交付。

### 开放问题

| 问题 | 最晚解决阶段 | 默认方案 |
|---|---|---|
| Bun、MCP SDK 与 SQLite 依赖能否稳定跨平台编译？ | Phase 0 | Spike 失败时保留 TypeScript packages，替换 sidecar 打包 runtime |
| 首批支持哪些 Hevy/Intervals 字段？ | Phase 1 | 以原型已验证字段和真实 fixture 为基线 |
| API key 如何安全传入 sidecar？ | Phase 4 前 | OS keyring + 短生命周期本地 IPC，不写磁盘 |
| OpenAI 首发具体支持哪些模型能力？ | Phase 4 | 只依赖工具调用、结构化输出和流式文本的公共子集 |

## 20. Definition of Done

### MCP MVP

> 在一台没有 Node、Bun、Python、Docker 或数据库环境的新电脑上，用户安装 Athria、导入训练数据并连接外部 MCP Agent。Agent 使用 Athria Skill 读取本地训练状态、编排一个计划、通过 Core validation 修订问题，并在用户批准后保存为新的不可变计划版本。整个过程不依赖 Athria 云服务器。

### 最终架构

> 用户在 Athria 中配置自己的模型 API key 后，内置 Agent 可以使用相同的 Skill、Tool API 和 Core validation 完成上述闭环；用户仍可选择外部 MCP Agent，且两种入口读写相同的本地数据与计划历史。

## 21. 文档自检

- **最强部分：** Core、Agent 与 Skill 的职责边界，以及 MCP 与内置 Agent 共用工具的约束。
- **最弱部分：** Bun sidecar 的跨平台生产打包和 API key IPC 尚未通过正式 spike。
- **最高风险假设：** TypeScript sidecar 能在保持轻量的同时满足三平台安装和 MCP stdio 使用体验。
- **下一步：** 先执行 Phase 0；在打包、SQLite 和双入口 MCP vertical slice 通过前，不开始完整 Dashboard 重写。
