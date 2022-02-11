/* global __resourceQuery, __webpack_hash__ */
/// <reference types="webpack/module" />
import webpackHotLog from "webpack/hot/log.js";
import stripAnsi from "./modules/strip-ansi/index.js";
import parseURL from "./utils/parseURL.js";
import socket from "./socket.js";
import { formatProblem, show, hide } from "./overlay.js";
import { log, setLogLevel } from "./utils/log.js";
import sendMessage from "./utils/sendMessage.js";
import reloadApp from "./utils/reloadApp.js";
import createSocketURL from "./utils/createSocketURL.js";

/**
 * @typedef {Object} Options
 * @property {boolean} hot
 * @property {boolean} liveReload
 * @property {boolean} progress
 * @property {boolean | { warnings?: boolean, errors?: boolean }} overlay
 * @property {string} [logging]
 * @property {number} [reconnect]
 */

/**
 * @typedef {Object} Status
 * @property {boolean} isUnloading
 * @property {string} currentHash
 * @property {string} [previousHash]
 */

/**
 * @type {Status}
 */
const status = {
  isUnloading: false,
  // TODO Workaround for webpack v4, `__webpack_hash__` is not replaced without HotModuleReplacement
  // eslint-disable-next-line camelcase
  currentHash: typeof __webpack_hash__ !== "undefined" ? __webpack_hash__ : "",
};

/** @type {Options} */
const options = {
  hot: false,
  liveReload: false,
  progress: false,
  overlay: false,
};
const parsedResourceQuery = parseURL(__resourceQuery);

if (parsedResourceQuery.hot === "true") {
  options.hot = true;

  log.info("Hot Module Replacement enabled.");
}

if (parsedResourceQuery["live-reload"] === "true") {
  options.liveReload = true;

  log.info("Live Reloading enabled.");
}

if (parsedResourceQuery.progress === "true") {
  options.liveReload = true;

  log.info("Progress reporting enabled.");
}

if (parsedResourceQuery.overlay) {
  try {
    options.overlay = JSON.parse(parsedResourceQuery.overlay);
  } catch (e) {
    log.error("Error parsing overlay options from resource query:", e);
  }

  // Fill in default "true" params for partially-specified objects.
  if (typeof options.overlay === "object") {
    options.overlay = {
      errors: true,
      warnings: true,
      ...options.overlay,
    };
  }

  if (
    options.overlay === true ||
    (options.overlay.errors && options.overlay.warnings)
  ) {
    log.info("Overlay is enabled for both errors and warnings.");
  } else if (options.overlay.errors) {
    log.info("Overlay is enabled for errors only.");
  } else if (options.overlay.warnings) {
    log.info("Overlay is enabled for warnings only.");
  }
}

if (parsedResourceQuery.logging) {
  options.logging = parsedResourceQuery.logging;
}

if (typeof parsedResourceQuery.reconnect !== "undefined") {
  options.reconnect = Number(parsedResourceQuery.reconnect);
}

/**
 * @param {string} level
 */
function setAllLogLevel(level) {
  // This is needed because the HMR logger operate separately from dev server logger
  webpackHotLog.setLogLevel(
    level === "verbose" || level === "log" ? "info" : level
  );
  setLogLevel(level);
}

if (options.logging) {
  setAllLogLevel(options.logging);
}

self.addEventListener("beforeunload", () => {
  status.isUnloading = true;
});

const onSocketMessage = {
  hot() {
    if (parsedResourceQuery.hot === "false") {
      return;
    }

    options.hot = true;

    log.info("Hot Module Replacement enabled.");
  },
  liveReload() {
    if (parsedResourceQuery["live-reload"] === "false") {
      return;
    }

    options.liveReload = true;

    log.info("Live Reloading enabled.");
  },
  invalid() {
    log.info("App updated. Recompiling...");

    // Fixes #1042. overlay doesn't clear if errors are fixed but warnings remain.
    if (options.overlay) {
      hide();
    }

    sendMessage("Invalid");
  },
  /**
   * @param {string} hash
   */
  hash(hash) {
    status.previousHash = status.currentHash;
    status.currentHash = hash;
  },
  logging: setAllLogLevel,
  /**
   * @param {boolean} value
   */
  overlay(value) {
    if (typeof document === "undefined") {
      return;
    }

    options.overlay = value;
  },
  /**
   * @param {number} value
   */
  reconnect(value) {
    if (parsedResourceQuery.reconnect === "false") {
      return;
    }

    options.reconnect = value;
  },
  /**
   * @param {boolean} value
   */
  progress(value) {
    options.progress = value;
  },
  /**
   * @param {{ pluginName?: string, percent: number, msg: string }} data
   */
  "progress-update": function progressUpdate(data) {
    if (options.progress) {
      log.info(
        `${data.pluginName ? `[${data.pluginName}] ` : ""}${data.percent}% - ${
          data.msg
        }.`
      );
    }

    sendMessage("Progress", data);
  },
  "still-ok": function stillOk() {
    log.info("Nothing changed.");

    if (options.overlay) {
      hide();
    }

    sendMessage("StillOk");
  },
  ok() {
    sendMessage("Ok");

    if (options.overlay) {
      hide();
    }

    reloadApp(options, status);
  },
  // TODO: remove in v5 in favor of 'static-changed'
  /**
   * @param {string} file
   */
  "content-changed": function contentChanged(file) {
    log.info(
      `${
        file ? `"${file}"` : "Content"
      } from static directory was changed. Reloading...`
    );

    self.location.reload();
  },
  /**
   * @param {string} file
   */
  "static-changed": function staticChanged(file) {
    log.info(
      `${
        file ? `"${file}"` : "Content"
      } from static directory was changed. Reloading...`
    );

    self.location.reload();
  },
  /**
   * @param {Error[]} warnings
   * @param {any} params
   */
  warnings(warnings, params) {
    log.warn("Warnings while compiling.");

    const printableWarnings = warnings.map((error) => {
      const { header, body } = formatProblem("warning", error);

      return `${header}\n${stripAnsi(body)}`;
    });

    sendMessage("Warnings", printableWarnings);

    for (let i = 0; i < printableWarnings.length; i++) {
      log.warn(printableWarnings[i]);
    }

    const needShowOverlayForWarnings =
      typeof options.overlay === "boolean"
        ? options.overlay
        : options.overlay && options.overlay.warnings;

    if (needShowOverlayForWarnings) {
      show("warning", warnings);
    }

    if (params && params.preventReloading) {
      return;
    }

    reloadApp(options, status);
  },
  /**
   * @param {Error[]} errors
   */
  errors(errors) {
    log.error("Errors while compiling. Reload prevented.");

    const printableErrors = errors.map((error) => {
      const { header, body } = formatProblem("error", error);

      return `${header}\n${stripAnsi(body)}`;
    });

    sendMessage("Errors", printableErrors);

    for (let i = 0; i < printableErrors.length; i++) {
      log.error(printableErrors[i]);
    }

    const needShowOverlayForErrors =
      typeof options.overlay === "boolean"
        ? options.overlay
        : options.overlay && options.overlay.errors;

    if (needShowOverlayForErrors) {
      show("error", errors);
    }
  },
  /**
   * @param {Error} error
   */
  error(error) {
    log.error(error);
  },
  close() {
    log.info("Disconnected!");

    if (options.overlay) {
      hide();
    }

    sendMessage("Close");
  },
};

const socketURL = createSocketURL(parsedResourceQuery);

socket(socketURL, onSocketMessage, options.reconnect);
