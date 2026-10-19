# Orochi AdBlock

自用 Chrome 广告拦截插件（Manifest V3），基于浏览器官方的
`declarativeNetRequest` 接口执行拦截，规则来自：

- **EasyList**（全球广告规则，约 5.9 万条网络规则）
- **EasyList China**（中文站点补充，约 1.1 万条）
- **EasyPrivacy**（反追踪，约 5.6 万条）

另带一份通用元素隐藏（cosmetic.js），抹掉常见广告容器。

v1.0 起带**设置页**（弹窗点「设置」进入）：可管理本站暂停的白名单、
逐个开关三套规则集、添加自己要拦截的域名（动态规则）和要隐藏的元素
选择器（全局生效），全部保存在本地存储中。

## 安装（开发者模式）

1. 下载本仓库并解压（或 `git clone`）
2. 如果 `rules/` 目录里没有 JSON，先生成规则（见下）
3. Chrome 打开 `chrome://extensions`，开启右上角「开发者模式」
4. 点「加载已解压的扩展程序」，选择本仓库根目录
5. 工具栏出现 Orochi AdBlock 图标即安装成功；图标徽标显示本页拦截数，
   点开弹窗可查看数量并一键暂停/恢复

## 生成规则

规则 JSON 由 `tools/convert.py` 从官方过滤列表转换得到（生成物不入库）：

```sh
curl -sL -o /tmp/easylist.txt       https://easylist.to/easylist/easylist.txt
curl -sL -o /tmp/easylistchina.txt  https://raw.githubusercontent.com/easylist/easylistchina/master/easylistchina.txt
curl -sL -o /tmp/easyprivacy.txt    https://easylist.to/easylist/easyprivacy.txt
python3 tools/convert.py /tmp/easylist.txt       rules/easylist.json
python3 tools/convert.py /tmp/easylistchina.txt  rules/easylistchina.json
python3 tools/convert.py /tmp/easyprivacy.txt    rules/easyprivacy.json
```

更新规则 = 重跑一遍上面的命令，然后在 `chrome://extensions` 里点插件的刷新按钮。

## 已知边界

- YouTube 等「广告与正片同域名」的站点，规则拦截效果有限（所有同类插件通病）
- 部分网站会检测拦截器并弹窗提示关闭，属猫鼠游戏，后续版本再适配
- 拦截计数依赖 `onRuleMatchedDebug`，仅在开发者模式加载时可用

## 版本

- v1.0.0 — 完工版：新增设置页（白名单管理、三套规则集独立开关、自定义拦截域名 + 自定义隐藏选择器）；popup 增加「设置」入口；规则刷新至最新版（共 126,608 条：EasyList 58,989 + EasyList China 11,339 + EasyPrivacy 56,280）。由 Hermes 开发军团（builder）实现、Orochi 验收：原有 37 项 + 新增 16 项测试与 14 项运行时检查全部通过。

- v0.2.0 — 新增站点暂停/恢复（白名单持久保存，网络放行并跳过元素隐藏）；弹窗在本页计数旁显示持久保存的累计拦截数。站点设置修改后请刷新页面以应用元素隐藏设置；累计计数同样依赖开发者模式的 `onRuleMatchedDebug`，全局开关保持不变。
- v0.1.0 — MVP：网络请求拦截 + 通用元素隐藏 + 弹窗计数与总开关
