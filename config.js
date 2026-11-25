/**
 * Obsidian書庫AI — 設定ファイル
 * ここだけ書き換えれば、コード本体を触らずに接続先を差し替えられます。
 *
 * ※ APIキー・パスワードなどの秘密情報は絶対にここへ書かないでください。
 *    （APIキーは GAS の「スクリプトプロパティ」にだけ保存します）
 */
window.APP_CONFIG = {
  // GAS「ウェブアプリ」のURL（https://script.google.com/macros/s/xxxx/exec）
  // 空のままにすると、画面の「⚙ 設定」から入力したURL（ブラウザに保存）を使います。
  GAS_URL: "",

  // アプリ名とバージョン（ヘッダー・フッターに表示）
  APP_NAME: "Obsidian書庫AI",
  APP_VERSION: "v1.1.0",

  // 出典ノートを Obsidian アプリで開くリンクを表示する場合は保管庫名を入れる（例: "健二保管庫"）
  // 空なら表示しません。リンクは作成者本人の端末でのみ機能します。
  OBSIDIAN_VAULT_NAME: "",

  // 読み上げ音声の候補（Gemini TTS のプリセットボイス名）
  TTS_VOICES: [
    { id: "Kore", label: "Kore（落ち着いた声）" },
    { id: "Aoede", label: "Aoede（やわらかい声）" },
    { id: "Puck", label: "Puck（明るい声）" },
    { id: "Charon", label: "Charon（低めの声）" },
    { id: "Leda", label: "Leda（若々しい声）" },
    { id: "Zephyr", label: "Zephyr（さわやかな声）" }
  ]
};
