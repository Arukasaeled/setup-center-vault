# Setup Center Vault

> **Decoupled Content Vault for Setup Center** — Creative & Development Bootstrap Hub.

## 核心定位

Setup Center 将应用运行时与内容数据解耦。
- **Setup Center App**：负责系统探测、安装调度、UI 渲染、脚手架执行与动态样式挂载。
- **Setup Center Vault**：作为独立远程内容库，承载视觉风格（Styles）、开发资源（Resources）、工程脚手架（Templates）、UI 交互模式（Patterns）、Agent 技能（Skills）与收集箱（Inbox）。

当 Vault 更新内容时，客户端通过 **Runtime Content Update** 协议拉取最新清单与资产，**无需重新编译或发布桌面客户端**。

---

## 目录结构

```
setup-center-vault/
├── manifest.json            # 顶层内容清单（声明版本、更新时间与集合索引）
├── schemas/                 # 机器可读 JSON Schema 规范
│   ├── vault-manifest.schema.json
│   ├── style.schema.json
│   ├── resource.schema.json
│   ├── template.schema.json
│   ├── pattern.schema.json
│   ├── skill.schema.json
│   └── inbox.schema.json
├── styles/                  # 视觉设计系统（CSS 样式 + 元数据清单）
│   ├── blueprint/
│   ├── y2k-digital/
│   ├── newspaper-editorial/
│   └── cyber-neon/
├── resources/               # 精选开发资源（按分类组织 JSON）
│   ├── frontend.json
│   ├── components.json
│   ├── tools.json
│   ├── ai.json
│   └── ...
├── templates/               # 工程模板与脚手架元数据
│   ├── tauri-v2-react/
│   ├── create-t3-app/
│   ├── rust-cli-starter/
│   └── python-uv-fastapi/
├── patterns/                # 可复用 UI / 交互模式规范 (34 项)
├── skills/                  # 面向 Agent 与开发者的 Transfer 技能 (21 项)
└── inbox/                   # 外部链接收集箱（等待结构化入库）
```

### 资产规模与收录基线
- **视觉风格 (Styles)**：20 套独立设计系统体验（客户端内置 14 套离线基线，6 套动态按需同步）。
- **精选资源 (Resources)**：172+ 项开源工具、框架与设计资产，覆盖 10 大分类。
- **工程模板 (Templates)**：28 套结构化工程脚手架模板（包含 Node/Tauri/Rust/Python 等初始化配方）。
- **交互模式 (Patterns)**：34 套 WAI-ARIA 与现代化交互组件设计规范。
- **Transfer 技能 (Skills)**：21 项 Agent 迁移与工作流自动化技能。

---

## 前置要求与开发环境

- **Node.js**：20.19+ / 22.12+ (LTS)
- **npm**：10+

### 验证与质量门禁

在提交更改或发起 Pull Request 前，必须运行本地契约与结构验证：

```bash
# 全量内容与 Schema 契约校验
node scripts/validate.mjs --content-only
```

---

## 扩充协议 (Zero Rebuild Extension)

1. **添加开发资源**：在对应 `resources/<category>.json` 中追加一条符合 `resource.schema.json` 的 JSON 对象。
2. **添加新风格**：在 `styles/<id>/` 下放置 `manifest.json` 与 `<id>.css`。
3. **添加新模板**：在 `templates/<id>/` 下放置 `template.json`。
4. **更新清单**：递增 `manifest.json` 中的 `contentVersion` 与计数器。
5. **生效**：客户端在启动或点击「检查更新」时自动无缝增量加载。

