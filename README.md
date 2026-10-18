# Retirement Calculator

个人资产聚合与投资组合可视化平台。自动从 Empower 抓取账户数据，统一展示持仓分析、历史收益、市场信号与退休规划。

## 功能

- **Empower 数据同步**：API 拦截方式获取持仓与账户余额，无需手动导出
- **多视图持仓展示**：按类型（默认）/ 按账户 / 按资产
- **收益追踪**：历史快照 + 现金流，浏览器端按区间连乘 Modified Dietz 估算时间加权收益率；仅合并共同估值日期，缺少可靠期初余额时显示空值。
- **大盘脉搏**：VIX / VXN / Fear & Greed / RSI 四信号汇流，DCA 时机建议 + 个人持仓 notice
- **AI 归因分析**：Claude API 生成中文持仓归因，内联展示
- **退休计算器**：Monte Carlo 退休规划（1000 次模拟），拖拽式多阶段支出时间轴，基于当前持仓权重的个性化收益率模型

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | FastAPI + SQLite (WAL) + SQLModel |
| 前端 | React 18 + TypeScript + Vite |
| 爬虫 | Playwright（持久 Chromium profile） |
| AI | Anthropic Claude API |
| 行情数据 | yfinance |

## 快速开始

```bash
# 后端依赖
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 前端依赖
cd frontend && npm install && cd ..

# 配置凭据
cp .env.example .env
# 编辑 .env，填写 Empower 账户凭据
```

启动开发服务器：

```bash
# 终端 1：后端 (port 8000)
source .venv/bin/activate
uvicorn backend.main:app --reload --host 0.0.0.0

# 终端 2：前端 (port 5175)
cd frontend && npm run dev
```

访问 `http://localhost:5175`

## 数据同步

```bash
source .venv/bin/activate
python scripts/scrape_empower.py --target local
```

## 环境变量（.env）

```env
# 运行环境: local | gcp（默认 local）
APP_ENV=local

# 数据目录（默认 ~/.retirement-calculator/）
# DATA_DIR=/mnt/data/retirement-calculator

# Empower 凭据
EMPOWER_EMAIL=
EMPOWER_PASSWORD=

# Claude API（可选，启用 AI 归因分析）
ANTHROPIC_API_KEY=

# Benchmark 权重（默认 60% SPY / 40% AGG）
# BENCHMARK_TICKERS=SPY:0.6,AGG:0.4
```

## 项目结构

```
├── backend/
│   ├── main.py              # FastAPI 入口 + 展示层清洗逻辑
│   ├── db.py                # 数据库模型与操作
│   ├── ingest.py            # /api/ingest 接入层
│   ├── empower_client.py    # Empower 爬虫（API 拦截）
│   ├── sync.py              # 同步触发与状态管理
│   ├── checks.py            # 同步数据合理性校验
│   ├── attribution.py       # Claude API 集成
│   ├── market_fetcher.py    # 行情抓取（yfinance + F&G）
│   ├── market_pulse.py      # 四信号汇流引擎
│   ├── holding_mapper.py    # 持仓 DCA notice 生成
│   └── config.py            # 环境配置
├── scripts/
│   ├── scrape_empower.py    # 本地触发同步
│   └── backup_db.sh         # SQLite → GCS 备份脚本
├── DESIGN.md                # 设计系统（Terminal Provenance）
└── frontend/src/
    ├── App.tsx                      # 顶层布局，Tab 路由
    ├── Portfolio.tsx                # 多视图持仓展示
    ├── PerformanceChart.tsx         # TWR 折线图 + 账户筛选
    ├── SyncLogPanel.tsx             # 同步历史面板
    ├── SyncButton.tsx               # 同步触发按钮
    ├── Attribution.tsx              # AI 持仓归因
    ├── MarketPulse.tsx              # 大盘脉搏页面
    ├── RetirementCalculator.tsx     # 退休计算器主页面
    ├── RetirementAccountTagger.tsx  # 账户标记 + useRetirementData hook
    ├── SpendingTimeline.tsx         # 拖拽式多阶段支出时间轴
    ├── RetirementChart.tsx          # Monte Carlo 图表 + OutputCards
    ├── retirement.ts                # Monte Carlo 引擎
    ├── twr.ts                       # TWR 计算（子区间链式）
    └── api.ts                       # API 封装
```

## 核心设计原则

- **原始数据入库，清洗在响应时发生**：修改分类规则只需重启服务，无需重新同步
- **账户余额来自 `Account` 表**：不是累加持仓，可正确反映 Empower 各子账户余额
- **TWR 在浏览器端计算**：切换账户筛选无需额外 API 请求
- **持久 Chromium profile**：设备信任后续同步跳过 MFA

## 数据库

SQLite，位于 `~/.retirement-calculator/retirement-calculator.db`。

| 表 | 内容 |
|---|---|
| Account | 每个账户余额 |
| Holding | 当前持仓明细，每次同步覆盖写入 |
| Snapshot | 历史净值快照，per-(source, account, date) |
| CashFlow | 现金流入/出记录，用于 TWR 计算 |
| SyncLog | 每次 ingest 记录（source、count、total、status、warnings） |
| PriceHistory | SP500/NDX 日收盘价（5 年） |
| MarketSignals | 每日 VIX/VXN/F&G/RSI 快照 |
| BenchmarkCache | Benchmark 日收益率缓存 |
| AttributionCache | AI 解读结果缓存 |
| RetirementAccountTag | 账户退休属性标记 |
| RetirementScenario | 退休规划方案存储 |

常用查询：

```bash
DB=~/.retirement-calculator/retirement-calculator.db

# 持仓汇总
sqlite3 $DB "SELECT source, COUNT(*) holdings, ROUND(SUM(value_usd),0) total FROM holding GROUP BY source;"

# 账户列表
sqlite3 $DB "SELECT source, firm_name, name, ROUND(balance,0) balance FROM account;"

# 最近快照
sqlite3 $DB "SELECT source, account_name, snapshot_date, ROUND(total_value_usd,0) total
             FROM snapshot ORDER BY snapshot_date DESC LIMIT 20;"
```

## 测试

```bash
# 后端
pytest backend/tests/

# 前端（twr.ts 单元测试）
cd frontend && npm test
```

## 设计系统

详见 `DESIGN.md`。主题：Terminal Provenance（暗色，Bloomberg 风格）。

- **字体**：Space Grotesk（UI）+ JetBrains Mono（数字）+ LXGW WenKai（中文注释）
- **配色**：`#0E0E0E` 背景，`#C8A96E` 金色（收益），`#C06B5A` 赭石（亏损）
