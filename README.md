<div align="center">
  <img src="apps/desktop/public/athria-logo.svg" alt="Athria logo" width="120">

# Athria

**Local-first training data and planning tools for MCP clients.**

[![Version](https://img.shields.io/badge/version-0.2.0-315c4c)](package.json)
![Platforms](https://img.shields.io/badge/platforms-Windows%20x64%20%7C%20macOS%20Apple%20Silicon-315c4c)
![Runtime](https://img.shields.io/badge/runtime-local--first-e9a23b)
</div>

[English](#english) · [简体中文](#简体中文)

<a id="english"></a>

## English

Athria is a desktop training dashboard and MCP server that keeps an athlete's profile, wellness, training history, session templates, and single current mesocycle on their own computer. External MCP clients such as Codex, Claude Desktop, Cursor, Qoder, or Trae can use Athria's structured tools to read training state, calculate metrics, validate plans, and make controlled updates.

Athria's deterministic Core performs calculations and validation; the connected MCP client handles natural-language planning and explanation.

### English contents

- [What Athria does](#what-athria-does)
- [What Athria does not do](#what-athria-does-not-do)
- [Why use Athria](#why-use-athria)
- [Quick start](#quick-start)
- [Connect an MCP client](#connect-an-mcp-client)
- [Example workflow](#example-workflow)
- [Development](#development)
- [Project structure](#project-structure)
- [Data and security](#data-and-security)
- [Documentation and support](#documentation-and-support)
- [Contributing](#contributing)
- [Maintainer](#maintainer)

## What Athria does

The current MCP MVP provides:

- A Tauri 2 and React desktop dashboard for setup, history, training state, devices, templates, and the current mesocycle.
- Local SQLite persistence with migrations, WAL, and restore; back up manually by copying the database file.
- MCP `2025-11-25` and `2026-07-28` over stdio, plus authenticated Streamable HTTP on a loopback-only address.
- Deterministic strength and endurance metrics with formula versions and explicit data-quality indicators.
- Plan Schema v7 validation with fixed-week, flexible-week, and interval rhythms, authoritative Weekly Sessions, structured multi-sport prescriptions, and independent phase timelines by domain.
- A reusable Session Template Library and one editable Current Mesocycle per athlete.
- Optimistic revision checks and validation gates for MCP writes.
- Hevy CSV import with preview-before-commit, plus read-only Intervals.icu and Xunji synchronization.
- Provider-neutral Skills for training-plan workflows and locally synchronized Xunji records.

Athria currently targets Windows x64 and Apple Silicon macOS. The interface is English-only.

## What Athria does not do

Athria does **not** include an LLM, chat interface, hosted AI provider, account system, cloud database, mobile app, or third-party write-back. Your MCP client supplies the model and remains responsible for its own configuration and cost.

Athria also does not diagnose injuries, prescribe treatment, make medical decisions, or certify that a workout is medically safe. Missing health, recovery, load, RPE, heart-rate, or power data remains explicitly missing rather than being treated as normal.

See [Known limitations](docs/KNOWN_LIMITATIONS.md) for the current technical and product boundaries.

## Why use Athria

- **Local by default:** core training data stays on your computer; no Athria cloud service or account is required.
- **Works with your MCP client:** use a compatible external client instead of being locked to one model provider.
- **Reproducible results:** calculations and rules live in a testable Core rather than in model prompts.
- **Safer writes:** schema checks, blocker rules, snapshot freshness, ownership, and revisions protect persisted state.
- **Honest uncertainty:** validation reports missing facts and unknown outcomes instead of inventing inputs.
- **Inspectable workflows:** the dashboard and MCP server use the same application-service boundary.
- **Portable data:** open or back up one standalone SQLite database; one database password gates access inside Athria and encrypts the connection keys that travel with the file.

## Quick start

### Prerequisites for source builds

- [Node.js](https://nodejs.org/) 24 or newer and [pnpm](https://pnpm.io/) 11.19.0
- A stable [Rust](https://www.rust-lang.org/tools/install) toolchain
- Windows x64: Microsoft Visual C++ Build Tools and the Windows SDK
- macOS: Apple Silicon and Xcode Command Line Tools

### Run the development app

```sh
git clone https://github.com/whywww/Athria.git
cd Athria
pnpm install
pnpm dev
```

`pnpm dev` starts Vite and the Tauri debug application backed by the shared Rust runtime.

### Build a desktop app

```sh
# Directly runnable host-native debug app
pnpm build:debug

# Directly runnable host-native release app
pnpm build:app

# Windows: MSI; macOS: app and DMG
pnpm release:native
```

Keep the checkout in a directory named `Athria-repo`. Every generated file is written to its sibling `Athria` directory and separated by purpose and target triple; the build location is intentionally not configurable. Packaged apps embed the shared Rust runtime and do not require a separate Node.js, Rust, Python, Docker, or database installation.

On first launch, use Settings to complete Personal Information and Profile to configure training preferences, then import or synchronize any training records you want Athria to use. Stable personal details live in Profile; dated weight entries live in Wellness.

## Connect an MCP client

Use the installed Athria desktop executable as a stdio MCP server. Replace the command with the actual installation path on your computer.

### Windows

```json
{
  "mcpServers": {
    "Athria": {
      "command": "C:\\Program Files\\Athria\\Athria.exe",
      "args": ["mcp"]
    }
  }
}
```

### macOS

```json
{
  "mcpServers": {
    "Athria": {
      "command": "/Applications/Athria.app/Contents/MacOS/athria",
      "args": ["mcp"]
    }
  }
}
```

Save the configuration and restart the MCP client. Athria reserves stdout for JSON-RPC and sends diagnostics to stderr.

For client-specific setup paths, Streamable HTTP details, and write boundaries, read [MCP setup](docs/MCP.md). Connecting the MCP server does not automatically install the optional Skills in [`packages/skills`](packages/skills).

## Example workflow

After connecting Athria, ask your MCP client:

```text
Review my last 30 days of training, identify any important data gaps, and
draft a four-week mesocycle around my confirmed schedule and equipment.
Validate it with Athria before showing it to me. Do not save anything until
I explicitly approve the plan.
```

A typical planning flow is:

1. Read the confirmed profile, wellness, current state, taxonomy, and relevant history.
2. Surface missing facts that matter to blocker rules.
3. Create or update reusable session templates.
4. Assemble a fixed-week, flexible-week, or interval mesocycle that references those templates.
5. Validate, revise, and explain the result.
6. Save only after the user confirms the proposed changes.

Profile changes from MCP require explicit user confirmation and a current profile hash, then write directly. Dashboard edits write directly as well.

## Development

Install dependencies, then use the root workspace scripts:

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm check
cargo test --workspace
```

Useful commands:

| Command | Purpose |
|---|---|
| `pnpm dev` | Run the Tauri desktop app in development mode |
| `pnpm typecheck` | Type-check the desktop frontend |
| `pnpm test` | Run the Vitest frontend suite |
| `pnpm check` | Run frontend checks and Skill validation |
| `cargo test --workspace` | Run the Rust workspace tests |
| `pnpm build:app` | Build a directly runnable release app |
| `pnpm release:native` | Produce native installer artifacts |

The default development database is stored at:

- Windows: `%LOCALAPPDATA%\Athria\data\athria.sqlite3`
- macOS: `~/Library/Application Support/Athria/data/athria.sqlite3`

Set `ATHRIA_DATABASE_PATH` when an isolated development database is needed. Do not point tests or experiments at personal training data.

## Project structure

```text
apps/
  desktop/       Tauri shell and React dashboard
crates/           Shared Rust core, application, storage, integrations, MCP, and runtime
packages/
  skills/        Optional provider-neutral MCP workflows
schemas/         Versioned JSON Schema contracts
scripts/         Development and release tooling
```

The dashboard and MCP server call the same application-service boundary. Business writes must not bypass the shared schemas, permission checks, Core validation, or persistence layer.

## Data and security

- The service listens only on `127.0.0.1`, validates the Host header, and restricts browser origins.
- Streamable HTTP requires a bearer token; the dashboard-managed MCP token is stored in the operating-system credential manager and is not exposed through MCP tools.
- MCP does not expose arbitrary SQL, arbitrary file reads, secrets, database deletion, or validation bypasses.
- One database password gates access inside Athria and wraps the master key that encrypts saved connection keys. When setting or entering it, you can choose whether this computer should remember it; otherwise Athria asks again after the app restarts.
- Backups are self-contained `.sqlite3` file copies made by the user and include connection keys only as authenticated ciphertext protected by the database password.
- Databases older than the schema version 24 Rust compatibility baseline are not migrated into this MVP.

Read [Backup and restore](docs/BACKUP.md) before moving or restoring data.

## Documentation and support

- [MCP setup](docs/MCP.md)
- [Backup and restore](docs/BACKUP.md)
- [Known limitations](docs/KNOWN_LIMITATIONS.md)
- [Release artifacts](docs/RELEASE.md)

For bugs and feature requests, use [GitHub Issues](https://github.com/whywww/Athria/issues). Include the platform, Athria version, reproduction steps, expected result, and actual result. Never attach credentials or personal training data.

## Contributing

Contributions are welcome. Keep changes focused on the MCP application and its deterministic Core.

1. Open an issue before a substantial architectural or schema change.
2. Create a focused branch and add tests for changed behavior.
3. Run `pnpm check` and `cargo test --workspace`.
4. Update schemas and documentation when contracts change.
5. Open a pull request that explains the change and how it was verified.

Do not commit local databases, imports, backups, credentials, signing material, or generated build artifacts.

## Maintainer

Athria is maintained by [Haoyu Wei](https://github.com/whywww) and contributors.

---

<a id="简体中文"></a>

## 简体中文

Athria 是一个本地优先的桌面训练管理应用和 MCP 服务器。运动者的个人资料、偏好、训练记录、训练模板和当前训练周期均保存在自己的电脑上。Codex、Claude Desktop、Cursor、Qoder 或 Trae 等外部 MCP 客户端可以通过 Athria 的结构化工具读取训练状态、计算指标、校验计划并执行受控更新。

Athria 的确定性 Core 负责计算和校验；连接的 MCP 客户端负责理解自然语言、编排计划和解释结果。

### 中文目录

- [Athria 可以做什么](#athria-可以做什么)
- [Athria 不做什么](#athria-不做什么)
- [为什么使用 Athria](#为什么使用-athria)
- [快速开始](#快速开始)
- [连接 MCP 客户端](#连接-mcp-客户端)
- [工作流示例](#工作流示例)
- [开发](#开发)
- [项目结构](#项目结构)
- [数据与安全](#数据与安全)
- [文档与支持](#文档与支持)
- [参与贡献](#参与贡献)
- [维护者](#维护者)

## Athria 可以做什么

当前 MCP MVP 提供：

- 基于 Tauri 2 和 React 的桌面 Dashboard，用于初始设置、训练历史、训练状态、设备连接、训练模板和当前训练周期管理。
- 使用 SQLite、migration 和 WAL 的本地数据持久化与恢复能力；备份即手动复制数据库文件。
- 基于 stdio 的 MCP `2025-11-25` 与 `2026-07-28`，以及仅在本机回环地址提供、需要身份验证的 Streamable HTTP。
- 可复现的力量与耐力训练指标，并明确标记公式版本和数据质量。
- 基于 Plan Schema v7 的计划校验，支持固定周、灵活周和间隔节奏、权威周处方、结构化多运动内容和各领域独立 phase timeline。
- 可复用的 Session Template Library，以及每位运动者一个可编辑的 Current Mesocycle。
- 使用 revision 乐观锁和校验门禁保护 MCP 写入。
- 提交前可预览的 Hevy CSV 导入，以及只读的 Intervals.icu 和训记同步。
- 面向训练计划工作流和本地训记记录的、与模型提供商无关的 Skills。

Athria 当前支持 Windows x64 和 Apple Silicon Mac，界面语言目前仅为英语。

## Athria 不做什么

Athria **不包含** LLM、内置聊天界面、托管的 AI Provider、账号系统、云数据库、移动应用或向第三方平台回写数据的能力。模型由 MCP 客户端提供，其配置与费用也由该客户端负责。

Athria 不诊断伤病、不提供治疗方案、不作医疗决定，也不保证某项训练在医学上安全。缺失的健康、恢复、负重、RPE、心率或功率数据会保持为缺失状态，不会被解释为正常。

当前技术和产品边界详见[已知限制](docs/KNOWN_LIMITATIONS.md)。

## 为什么使用 Athria

- **默认本地运行：** 核心训练数据保存在自己的电脑上，不需要 Athria 云服务或账号。
- **兼容现有 MCP 客户端：** 可以选择兼容的外部客户端，不被单一模型提供商绑定。
- **结果可复现：** 计算公式和规则位于可测试的 Core，而不是模型提示词中。
- **写入更安全：** Schema、阻断规则、快照时效、数据归属和 revision 共同保护持久化状态。
- **如实呈现不确定性：** 校验会报告缺失事实和未知结果，而不是编造输入。
- **工作流可检查：** Dashboard 和 MCP 服务器共用同一个 Application Service 边界。
- **数据可迁移：** 手动复制的数据库文件即完整备份，连接凭据仅以密文形式包含其中。

## 快速开始

### 源码构建前置条件

- [Node.js](https://nodejs.org/) 24 或更高版本，以及 [pnpm](https://pnpm.io/) 11.19.0
- 稳定版 [Rust](https://www.rust-lang.org/tools/install) 工具链
- Windows x64：Microsoft Visual C++ Build Tools 和 Windows SDK
- macOS：Apple Silicon Mac 和 Xcode Command Line Tools

### 运行开发版本

```sh
git clone https://github.com/whywww/Athria.git
cd Athria
pnpm install
pnpm dev
```

`pnpm dev` 会启动 Vite 和使用共享 Rust runtime 的 Tauri 调试应用。

### 构建桌面应用

```sh
# 可直接运行的当前平台调试应用
pnpm build:debug

# 可直接运行的当前平台发布应用
pnpm build:app

# Windows 生成 MSI；macOS 生成 app 和 DMG
pnpm release:native
```

请将代码仓库保存在名为 `Athria-repo` 的目录中。所有生成文件均写入其同级的 `Athria` 目录，并按用途和 target triple 分开存放；构建位置不可更改。打包后的应用内嵌共享 Rust runtime，运行时不需要另外安装 Node.js、Rust、Python、Docker 或外部数据库。

首次启动后，请先在 Dashboard 中完成运动者资料和偏好设置，再导入或同步希望 Athria 使用的训练记录。

## 连接 MCP 客户端

将安装后的 Athria 桌面可执行文件配置为 stdio MCP 服务器。请把示例中的命令路径替换为电脑上的实际安装路径。

### Windows

```json
{
  "mcpServers": {
    "Athria": {
      "command": "C:\\Program Files\\Athria\\Athria.exe",
      "args": ["mcp"]
    }
  }
}
```

### macOS

```json
{
  "mcpServers": {
    "Athria": {
      "command": "/Applications/Athria.app/Contents/MacOS/athria",
      "args": ["mcp"]
    }
  }
}
```

保存配置后重启 MCP 客户端。Athria 的 stdout 仅用于 JSON-RPC，诊断信息会写入 stderr。

各客户端的具体设置入口、Streamable HTTP 说明和写入边界详见 [MCP 设置](docs/MCP.md)。连接 MCP 服务器不会自动安装 [`packages/skills`](packages/skills) 中的可选 Skills。

## 工作流示例

连接 Athria 后，可以向 MCP 客户端提出：

```text
查看我最近 30 天的训练，指出会影响计划的重要数据缺口，并根据我已确认的
时间和器材拟定一个四周训练周期。先用 Athria 完成校验，再把计划展示给我。
在我明确批准之前，不要保存任何内容。
```

典型的计划工作流是：

1. 读取已确认的个人资料、偏好、当前状态、taxonomy 和相关训练历史。
2. 指出会影响阻断规则的缺失事实。
3. 创建或更新可复用的训练模板。
4. 创建引用这些模板、按自然周稀疏编排的训练周期。
5. 校验、修订并解释结果。
6. 仅在用户确认拟议变更后保存。

通过 MCP 修改个人资料时，必须由用户明确确认并提供当前个人资料哈希，之后会直接写入。Dashboard 中的编辑也会直接写入。

## 开发

安装依赖后，使用根工作区脚本：

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm check
cargo test --workspace
```

常用命令：

| 命令 | 用途 |
|---|---|
| `pnpm dev` | 以开发模式运行 Tauri 桌面应用 |
| `pnpm typecheck` | 检查桌面前端类型 |
| `pnpm test` | 运行 Vitest 前端测试 |
| `pnpm check` | 运行前端检查和 Skill 校验 |
| `cargo test --workspace` | 运行 Rust workspace 测试 |
| `pnpm build:app` | 构建可直接运行的发布应用 |
| `pnpm release:native` | 生成原生安装包 |

默认开发数据库位置：

- Windows：`%LOCALAPPDATA%\Athria\data\athria.sqlite3`
- macOS：`~/Library/Application Support/Athria/data/athria.sqlite3`

需要隔离的开发数据库时，请设置 `ATHRIA_DATABASE_PATH`。请勿让测试或实验使用个人训练数据。

## 项目结构

```text
apps/
  desktop/       Tauri 外壳和 React Dashboard
crates/           共用 Rust Core、Application、存储、集成、MCP 与 runtime
packages/
  skills/        可选、与模型提供商无关的 MCP 工作流
schemas/         版本化 JSON Schema contracts
scripts/         开发和发布工具
```

Dashboard 和 MCP 服务器调用同一个 Application Service 边界。业务写入不得绕过共用 Schema、权限检查、Core 校验或持久化层。

## 数据与安全

- 服务仅监听 `127.0.0.1`，校验 Host header，并限制浏览器 Origin。
- Streamable HTTP 需要 Bearer Token；Dashboard 管理的 MCP Token 保存在操作系统凭据管理器中，且不会通过 MCP 工具暴露。
- MCP 不提供任意 SQL、任意文件读取、密钥访问、数据库删除或绕过校验的能力。
- 备份为用户手动复制的 `.sqlite3` 数据库文件；连接凭据仅以受数据库密码保护的密文形式包含其中。
- 早于 Rust schema version 24 兼容基线的数据库不会迁移至当前 MVP。

移动或恢复数据之前，请阅读[备份与恢复](docs/BACKUP.md)。

## 文档与支持

- [MCP 设置](docs/MCP.md)
- [备份与恢复](docs/BACKUP.md)
- [已知限制](docs/KNOWN_LIMITATIONS.md)
- [发布产物](docs/RELEASE.md)

Bug 和功能建议请通过 [GitHub Issues](https://github.com/whywww/Athria/issues) 提交。请包含平台、Athria 版本、复现步骤、预期结果和实际结果。请勿附上凭据或个人训练数据。

## 参与贡献

欢迎参与贡献。变更应聚焦当前 MCP 应用及其确定性 Core。

1. 在进行重大架构或 Schema 变更前先创建 Issue。
2. 使用独立分支，并为行为变更添加测试。
3. 运行 `pnpm check` 和 `cargo test --workspace`。
4. Contract 变化时同步更新 Schema 和文档。
5. 创建 Pull Request，说明变更内容和验证方式。

请勿提交本地数据库、导入文件、备份、凭据、签名材料或构建产物。

## 维护者

Athria 由 [Haoyu Wei](https://github.com/whywww) 和贡献者共同维护。
