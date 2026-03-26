import React from "react";
import ReactDOM from "react-dom/client";
import PanelApp from "../panel/PanelApp";
import inlineCss from "./panel.css?inline";

const HOST_ID = "mail-sherlock-panel-host";

function mount(): void {
  if (document.getElementById(HOST_ID)) return;
  const host = document.createElement("div");
  host.id = HOST_ID;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = inlineCss;
  shadow.appendChild(style);
  const mountEl = document.createElement("div");
  mountEl.className = "ms-root";
  shadow.appendChild(mountEl);
  const root = ReactDOM.createRoot(mountEl);
  root.render(
    <React.StrictMode>
      <PanelApp />
    </React.StrictMode>
  );
}

mount();
