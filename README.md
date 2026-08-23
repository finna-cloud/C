# 墨藍藝廊｜SillyTavern Chat Interface

一套奶油白、墨黑與鈷藍配色的 SillyTavern 第三方前端擴充。它不取代或搬移聊天資料，只以全螢幕介面操作 SillyTavern 現有角色、群組、訊息、世界書與生成資訊。

## 安裝

1. 解壓縮 molan-gallery-st-extension.zip。
2. 將整個 molan-gallery-st-extension 資料夾放入：
   - 使用者安裝：SillyTavern/data/<你的使用者名稱>/extensions/
   - 全域安裝：SillyTavern/public/scripts/extensions/third-party/
3. 重新啟動 SillyTavern，或重新整理瀏覽器。
4. 點擊魔杖選單中的「墨藍藝廊」，即可開啟介面。

若你的 SillyTavern 支援「從 Git 儲存庫安裝」，需先將此資料夾放入 Git 儲存庫後再貼入網址；本 ZIP 本身不提供自動更新。

## 已接上的功能

- 顯示、搜尋及切換 SillyTavern 中實際存在的聊天室；聊天室刪除後會從列表消失
- 開啟聊天室時只載入供檢視；未經送出、續寫、重試或摘要等明確操作的生成會被中止，群組 Auto Mode 亦會關閉
- 角色總覽與完整角色卡管理：新增、修改、刪除、匯入 JSON／PNG／YAML／CHARX／BYAF，以及匯出 PNG／JSON
- 全部／收藏／群組篩選
- 建立新對話
- 送出訊息、執行 STscript／Slash Command、停止生成
- 檔案附件（沿用 SillyTavern 原生附件流程）
- 編輯及刪除訊息
- 重試最後一則角色回覆
- 將訊息建立為 Checkpoint 收藏
- 續寫
- 對話重新命名
- 刪除目前或列表中的任一聊天室
- 匯出目前或列表中的任一對話為 TXT
- 專注模式
- 世界書新增、匯入、條目修改及刪除
- 生成中心直接切換目前 API 可用模型
- API 實際輸入／回覆 Token、本次與累計用量統計
- 真正送出的使用者訊息次數統計；Swipe、續寫與重新生成不會增加次數
- 世界書、生成中心、使用者設定與更多操作皆在墨藍藝廊內顯示
- 每個聊天室獨立保存關係值與記憶摘要
- 記憶自動摘要：自訂提供給 AI 的摘要要求、輸出格式與觸發訊息數；AI 產生後可人工修改並作為後續系統記憶
- 聊天訊息區可獨立上下滑動，不影響輸入框與導覽列
- 桌機與手機版面
- Ctrl/Cmd + Shift + M 快速開關；Esc 關閉

## 資料與相容性

- 對話及角色資料仍由 SillyTavern 儲存。
- 關係值、摘要設定與摘要內容寫入目前聊天室的 chatMetadata.molan_gallery；已儲存摘要會透過 extension prompt 提供給後續 AI 回覆。
- 目前聊天用量寫入 chatMetadata.molan_gallery；全部累計寫入 extensionSettings.molan_gallery。
- Token 只採計 API 供應商回傳的 usage／usageMetadata；供應商未回傳時顯示「未提供」，不以估算值冒充實際用量。
- 關閉擴充後，原生 SillyTavern 介面仍可正常使用。
- 最低支援 SillyTavern 1.18.0；若你的版本較舊，請先更新至目前 release 版。

## 授權

AGPL-3.0-or-later
