const generatedDir = path.join(__dirname, "generated");
let filePath = null;
let originalName = null;

try {
  const files = fs.readdirSync(generatedDir);
  const match = files.find((f) => f.startsWith(fileId + "-"));
  if (match) {
    filePath = path.join(generatedDir, match);
    originalName = match.split("-").slice(1).join("-");
  }
} catch (e) { }

if (!filePath) {
  return res.status(404).json({
    error: "File not found or expired. Please regenerate the document.",
  });
}
