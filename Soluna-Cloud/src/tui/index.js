import React from "react";
import { render } from "ink";
import { App } from "./app.js";

const h = React.createElement;

export async function startTUI(options) {
  if (!process.stdin.isTTY) {
    throw new Error("TUI requires an interactive terminal (TTY). Use --print instead.");
  }

  const instance = render(h(App, options), {
    exitOnCtrlC: false,
  });

  await instance.waitUntilExit();
}
