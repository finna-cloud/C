# GuideLink 儀表板

白塔作業儀表板 SillyTavern UI Extension。

## 功能

只保留四個工具頁：

- 📩 通訊
- 🪐 任務發布
- 🧠 哨兵狀態
- 📋 日誌

此版本不會輸出狀態列，也不會接續劇情。所有結果只顯示在面板內，不會放入聊天輸入框。

## 安裝

將整個 `GuideLink-Dashboard` 資料夾放入其中一個位置：

- `SillyTavern/data/<user-handle>/extensions/GuideLink-Dashboard`
- `SillyTavern/public/scripts/extensions/third-party/GuideLink-Dashboard`

或上傳到公開 GitHub repo，使用 SillyTavern 的 Install Extension 安裝。

正確結構：

```text
GuideLink-Dashboard/
├─ manifest.json
├─ index.js
├─ style.css
└─ README.md
```

安裝後重新整理 SillyTavern，於 Manage Extensions 啟用「GuideLink 儀表板」。

## 注意

若雲端環境禁止第三方 UI Extension，需由伺服器管理者手動安裝。
