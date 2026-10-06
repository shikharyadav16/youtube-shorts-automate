const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { google } = require("googleapis");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIRECTORY = path.join(__dirname, "data");
const FINAL_DATA_FILE = path.join(DATA_DIRECTORY, "final.json");
const CREDENTIALS_DIRECTORY = path.join(__dirname, "credentials");
const GOOGLE_CREDENTIALS_FILE = path.join(
  CREDENTIALS_DIRECTORY,
  "secret.json",
);
const GOOGLE_TOKEN_FILE = path.join(CREDENTIALS_DIRECTORY, "token.json");
const UPLOAD_STATE_FILE = path.join(DATA_DIRECTORY, "upload-state.json");

app.use(
  cors({
    origin: [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`],
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

const IGEXPORT_ORIGIN = "https://igexport.com";
const IGEXPORT_REFERER = "https://igexport.com/en/video-download/";
const MAX_UPLOAD_COUNT = 60;

let oauthState;
let automationJob;

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} was not found`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${label} contains invalid JSON`);
    }
    throw error;
  }
}

function readUploadState() {
  try {
    const state = JSON.parse(fs.readFileSync(UPLOAD_STATE_FILE, "utf8"));
    const uploadReelUrl =
      typeof state.uploadReelUrl === "string"
        ? state.uploadReelUrl
        : state.lastUploaded &&
            typeof state.lastUploaded.reel_url === "string"
          ? state.lastUploaded.reel_url
          : null;
    const datetime =
      typeof state.datetime === "string"
        ? state.datetime
        : state.lastUploaded &&
            typeof state.lastUploaded.uploadedAt === "string"
          ? state.lastUploaded.uploadedAt
          : null;
    const normalized = { uploadReelUrl, datetime };

    if (
      Object.keys(state).length !== 2 ||
      !Object.hasOwn(state, "uploadReelUrl") ||
      !Object.hasOwn(state, "datetime")
    ) {
      writeUploadState(normalized);
    }

    return normalized;
  } catch (error) {
    if (error.code === "ENOENT") {
      return { uploadReelUrl: null, datetime: null };
    }
    if (error instanceof SyntaxError) {
      throw new Error("data/upload-state.json contains invalid JSON");
    }
    throw error;
  }
}

function saveGoogleTokens(tokens) {
  const currentTokens = fs.existsSync(GOOGLE_TOKEN_FILE)
    ? readJsonFile(GOOGLE_TOKEN_FILE, "YouTube OAuth token")
    : {};
  const updatedTokens = { ...currentTokens, ...tokens };
  fs.mkdirSync(CREDENTIALS_DIRECTORY, { recursive: true });
  fs.writeFileSync(
    GOOGLE_TOKEN_FILE,
    `${JSON.stringify(updatedTokens, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function writeUploadState(state) {
  const temporaryFile = `${UPLOAD_STATE_FILE}.${process.pid}.tmp`;
  try {
    const checkpoint = {
      uploadReelUrl: state.uploadReelUrl,
      datetime: state.datetime,
    };
    fs.writeFileSync(temporaryFile, `${JSON.stringify(checkpoint, null, 2)}\n`, {
      encoding: "utf8",
      flag: "w",
    });
    fs.renameSync(temporaryFile, UPLOAD_STATE_FILE);
  } catch (error) {
    if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    throw error;
  }
}

function readGoogleCredentials() {
  const credentials = readJsonFile(
    GOOGLE_CREDENTIALS_FILE,
    "credentials/secret.json",
  );
  const client = credentials.web || credentials.installed;

  if (!client || !client.client_id || !client.client_secret) {
    throw new Error(
      "credentials/secret.json must contain Google OAuth client credentials",
    );
  }

  const redirectUri =
    (client.redirect_uris || []).find((uri) =>
      uri.endsWith("/oauth2callback"),
    ) || `http://localhost:${PORT}/oauth2callback`;

  return { client, redirectUri };
}

function createOAuthClient() {
  const { client, redirectUri } = readGoogleCredentials();
  const oauth = new google.auth.OAuth2(
    client.client_id,
    client.client_secret,
    redirectUri,
  );

  try {
    oauth.setCredentials(readJsonFile(GOOGLE_TOKEN_FILE, "YouTube OAuth token"));
  } catch (error) {
    if (!error.message.includes("YouTube OAuth token was not found")) throw error;
  }

  oauth.on("tokens", (tokens) => {
    try {
      saveGoogleTokens(tokens);
    } catch (error) {
      console.error("[oauth] Could not save refreshed YouTube tokens:", error.message);
    }
  });

  return oauth;
}

async function fetchIgExport(targetUrl) {
  const api = new URL("/api/ig-reels/", IGEXPORT_ORIGIN);
  api.searchParams.set("url", targetUrl);
  api.searchParams.set("videoOnly", "1");

  const res = await fetch(api, {
    method: "GET",
    headers: {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": UA,
      referer: IGEXPORT_REFERER,
      origin: IGEXPORT_ORIGIN,
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `igexport returned non-JSON (${res.status}): ${text.slice(0, 160)}`,
    );
  }

  if (!res.ok || data.ok !== true) {
    throw new Error(
      data.error || data.message || `igexport responded ${res.status}`,
    );
  }
  return data;
}

function getInstagramShortcode(targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error("Invalid Instagram Reel URL");
  }

  if (!["instagram.com", "www.instagram.com"].includes(parsed.hostname)) {
    throw new Error("Only Instagram Reel URLs are supported");
  }

  const match = parsed.pathname.match(/^\/(?:reel|reels|p)\/([^/]+)/);
  if (!match) throw new Error("URL must point to an Instagram Reel or post");
  return match[1];
}

async function getVideoDownload(targetUrl) {
  getInstagramShortcode(targetUrl);
  const data = await fetchIgExport(targetUrl);
  const media = data.media || {};

  if (typeof media.videoUrl !== "string") {
    throw new Error("No video found for this Instagram post");
  }

  const videoUrl = new URL(media.videoUrl);
  const host = videoUrl.hostname.toLowerCase();
  if (
    videoUrl.protocol !== "https:" ||
    !(/\.(cdninstagram\.com|fbcdn\.net)$/.test(host) || host === "fbcdn.net")
  ) {
    throw new Error("Instagram returned an unsupported video host");
  }

  const filename = media.filename || `instagram-${getInstagramShortcode(targetUrl)}.mp4`;
  const downloadUrl =
    "/api/download?url=" +
    encodeURIComponent(media.videoUrl) +
    "&filename=" +
    encodeURIComponent(filename);

  return { videoUrl: media.videoUrl, filename, downloadUrl };
}

function makeTitle(caption) {
  const words = caption.trim().split(/\s+/).filter(Boolean).slice(0, 25);
  let title = "";
  for (const word of words) {
    const candidate = title ? `${title} ${word}` : word;
    if (candidate.length > 100) break;
    title = candidate;
  }
  if (!title) throw new Error("The reel caption is empty; a title is required");
  return title;
}

async function uploadRecord(record, job) {
  const { videoUrl } = await getVideoDownload(record.reel_url);
  const response = await fetch(videoUrl, {
    headers: {
      "user-agent": UA,
      referer: "https://www.instagram.com/",
      accept: "*/*",
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Video download failed with status ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length")) || 0;
  job.videoBytesSent = 0;
  job.videoBytesTotal = contentLength;

  const progressStream = new Transform({
    transform(chunk, encoding, callback) {
      job.videoBytesSent += chunk.length;
      callback(null, chunk);
    },
  });
  Readable.fromWeb(response.body).pipe(progressStream);

  const auth = createOAuthClient();
  const youtube = google.youtube({ version: "v3", auth });
  const result = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: makeTitle(record.caption),
        description: "",
        categoryId: "22",
      },
      status: { privacyStatus: "public" },
    },
    media: { body: progressStream, mimeType: "video/mp4" },
  });

  if (!result.data.id) {
    throw new Error("YouTube did not return a video ID");
  }
  return result.data.id;
}

function describeUploadError(error) {
  const response = error.response;
  const status = Number(response && response.status) || Number(error.code) || null;
  const apiError = response && response.data && response.data.error;
  const reason =
    apiError &&
    typeof apiError === "object" &&
    Array.isArray(apiError.errors) &&
    apiError.errors
      .map((item) => item.reason)
      .filter(Boolean)
      .join(", ");
  const apiMessage =
    apiError && typeof apiError === "object" ? apiError.message : apiError;
  const message = apiMessage || error.message || "Unknown upload error";

  if (status === 401 || message.toLowerCase() === "unauthorized") {
    const statusText = status ? ` (HTTP ${status})` : "";
    return {
      message: `YouTube rejected the saved authorization${statusText}. Reconnect YouTube, then retry.`,
      requiresReauth: true,
      diagnostic: `HTTP ${status || "unknown"}: ${message}${reason ? `; reason=${reason}` : ""}`,
    };
  }

  return {
    message: `${message}${status ? ` (HTTP ${status})` : ""}${reason ? `; reason=${reason}` : ""}`,
    requiresReauth: false,
    diagnostic: `${status ? `HTTP ${status}: ` : ""}${message}${reason ? `; reason=${reason}` : ""}`,
  };
}

function getResumeIndex(records, uploadReelUrl) {
  const lastUploadedIndex = uploadReelUrl
    ? records.findIndex((record) => record.reel_url === uploadReelUrl)
    : -1;
  return lastUploadedIndex === -1 ? 0 : lastUploadedIndex + 1;
}

async function runAutomation(records, startIndex, count) {
  const queue = records.slice(startIndex, startIndex + count);
  automationJob.status = "running";

  for (let index = 0; index < queue.length; index += 1) {
    const record = queue[index];
    automationJob.current = index + 1;
    automationJob.currentTitle = makeTitle(record.caption);
    automationJob.currentReelUrl = record.reel_url;
    automationJob.videoBytesSent = 0;
    automationJob.videoBytesTotal = 0;
    automationJob.message = `Uploading ${index + 1}/${count}`;

    try {
      await uploadRecord(record, automationJob);
      const checkpoint = {
        uploadReelUrl: record.reel_url,
        datetime: new Date().toISOString(),
      };
      writeUploadState(checkpoint);
      automationJob.completed += 1;
      automationJob.lastUploaded = {
        caption: automationJob.currentTitle,
        ...checkpoint,
      };
      automationJob.message = `Uploaded ${automationJob.completed}/${count}`;
    } catch (error) {
      const failure = describeUploadError(error);
      automationJob.status = "failed";
      automationJob.error = failure.message;
      automationJob.requiresReauth = failure.requiresReauth;
      automationJob.message = `Upload ${index + 1}/${count} failed`;
      console.error("[automation]", failure.diagnostic);
      return;
    }
  }

  automationJob.status = "completed";
  automationJob.message = `Finished: uploaded ${automationJob.completed} Short(s)`;
}

app.post("/api/convert", async (req, res) => {
  const { target_url: targetUrl } = req.body || {};
  if (!targetUrl || typeof targetUrl !== "string") {
    return res.status(400).json({ error: "target_url is required" });
  }

  try {
    return res.json({ ok: true, ...(await getVideoDownload(targetUrl.trim())) });
  } catch (error) {
    console.error("[convert]", error.message);
    return res.status(502).json({ error: error.message });
  }
});

app.get("/api/download", async (req, res) => {
  const { url, filename } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).send("url is required");
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).send("invalid url");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    !(/\.(cdninstagram\.com|fbcdn\.net)$/.test(host) || host === "fbcdn.net")
  ) {
    return res.status(400).send("host not allowed");
  }

  const safeName = (filename || "instagram-video.mp4")
    .toString()
    .replace(/[^\w.\-]+/g, "_")
    .slice(0, 120);

  try {
    const upstream = await fetch(url, {
      headers: {
        "user-agent": UA,
        referer: "https://www.instagram.com/",
        accept: "*/*",
      },
    });
    if (!upstream.ok || !upstream.body) {
      return res.status(502).send(`Upstream responded ${upstream.status}`);
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    const len = upstream.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    console.error("[download]", error.message);
    if (!res.headersSent) res.status(502).send("Download failed");
  }
});

app.get("/api/automation/status", (_req, res) => {
  try {
    const state = readUploadState();
    const records = readJsonFile(FINAL_DATA_FILE, "data/final.json");
    const lastRecord = Array.isArray(records)
      ? records.find((record) => record.reel_url === state.uploadReelUrl)
      : null;
    res.json({
      job: automationJob || null,
      lastUploaded: state.uploadReelUrl
        ? {
            uploadReelUrl: state.uploadReelUrl,
            datetime: state.datetime,
            caption: lastRecord ? lastRecord.caption : null,
          }
        : null,
      authenticated: fs.existsSync(GOOGLE_TOKEN_FILE),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/auth/google", (req, res) => {
  try {
    const auth = createOAuthClient();
    oauthState = crypto.randomBytes(32).toString("hex");
    const authorizationUrl = auth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["https://www.googleapis.com/auth/youtube.upload"],
      state: oauthState,
    });
    res.redirect(authorizationUrl);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get("/oauth2callback", async (req, res) => {
  if (!oauthState || req.query.state !== oauthState) {
    return res.status(400).send("Invalid or expired OAuth state");
  }
  oauthState = undefined;
  if (req.query.error) {
    return res.status(400).send(`YouTube authorization failed: ${req.query.error}`);
  }

  try {
    const auth = createOAuthClient();
    const { tokens } = await auth.getToken(req.query.code);
    auth.setCredentials(tokens);
    saveGoogleTokens(tokens);
    res.redirect("/?youtube=connected");
  } catch (error) {
    console.error("[oauth]", error.message);
    res.status(500).send(`YouTube authorization failed: ${error.message}`);
  }
});

app.post("/api/automation/start", async (req, res) => {
  const count = req.body && req.body.count;
  if (!Number.isInteger(count) || count < 1 || count > MAX_UPLOAD_COUNT) {
    return res
      .status(400)
      .json({ error: "count must be a whole number from 1 to 60" });
  }
  if (automationJob && automationJob.status === "running") {
    return res.status(409).json({ error: "An upload job is already running" });
  }

  let records;
  let state;
  try {
    records = readJsonFile(FINAL_DATA_FILE, "data/final.json");
    if (!Array.isArray(records)) {
      throw new Error("data/final.json must contain a JSON array");
    }
    state = readUploadState();
    if (!fs.existsSync(GOOGLE_TOKEN_FILE)) {
      return res.status(401).json({
        error: "Connect a YouTube account before starting uploads",
        authorizationUrl: "/auth/google",
      });
    }
    createOAuthClient();
  } catch (error) {
    if (error.message.includes("YouTube OAuth token was not found")) {
      return res.status(401).json({
        error: "Connect a YouTube account before starting uploads",
        authorizationUrl: "/auth/google",
      });
    }
    return res.status(500).json({ error: error.message });
  }

  const startIndex = getResumeIndex(records, state.uploadReelUrl);
  const available = records.length - startIndex;
  if (count > available) {
    return res.status(400).json({
      error: `Only ${available} records remain after the last uploaded Reel`,
    });
  }

  automationJob = {
    id: crypto.randomUUID(),
    status: "running",
    total: count,
    current: 0,
    completed: 0,
    currentTitle: "",
    currentReelUrl: "",
    videoBytesSent: 0,
    videoBytesTotal: 0,
    message: "Starting upload queue",
    error: null,
    lastUploaded: state.uploadReelUrl
      ? {
          uploadReelUrl: state.uploadReelUrl,
          datetime: state.datetime,
          caption:
            records.find((record) => record.reel_url === state.uploadReelUrl)
              ?.caption || null,
        }
      : null,
  };
  res.status(202).json({ job: automationJob });

  runAutomation(records, startIndex, count).catch((error) => {
    console.error("[automation]", error.message);
    automationJob.status = "failed";
    automationJob.error = error.message;
    automationJob.message = "Upload job failed";
  });
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
