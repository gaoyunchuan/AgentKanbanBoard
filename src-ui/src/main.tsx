import React, { lazy, Suspense, useState } from "react";
import ReactDOM from "react-dom/client";
import ChatApp from "./studio/ChatApp";
import "./index.css";

const LegacyApp = lazy(() => import("./App"));
function Root() {
  const [legacy, setLegacy] = useState(false);
  return legacy ? <><button className="legacy-return" onClick={() => setLegacy(false)}>← 返回聊天工作区</button><Suspense fallback={<p>正在打开旧版看板…</p>}><LegacyApp/></Suspense></> : <ChatApp onLegacy={() => setLegacy(true)}/>;
}
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><Root/></React.StrictMode>);
