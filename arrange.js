const fs = require("node:fs");
const path = require("node:path");

const dataDirectory = path.join(__dirname, "data");
const outputFile = path.join(dataDirectory, "final.json");

function shuffle(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[randomIndex]] = [items[randomIndex], items[index]];
  }
}

function getRecordSchema(record, file, index) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${file}: record ${index + 1} must be a JSON object`);
  }

  return Object.keys(record).sort().join("\0");
}

function main() {
  const inputFiles = fs
    .readdirSync(dataDirectory)
    .filter(
      (file) =>
        file.toLowerCase().endsWith(".json") &&
        file.toLowerCase() !== path.basename(outputFile).toLowerCase(),
    )
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (inputFiles.length === 0) {
    throw new Error(`No source JSON files found in ${dataDirectory}`);
  }

  let expectedSchema;
  const records = [];

  for (const file of inputFiles) {
    const filePath = path.join(dataDirectory, file);
    let contents;

    try {
      contents = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(`Could not parse ${file}: ${error.message}`);
    }

    if (!Array.isArray(contents)) {
      throw new Error(`${file} must contain a JSON array`);
    }

    contents.forEach((record, index) => {
      const schema = getRecordSchema(record, file, index);
      if (expectedSchema === undefined) {
        expectedSchema = schema;
      } else if (schema !== expectedSchema) {
        throw new Error(`${file}: record ${index + 1} has a different schema`);
      }
      records.push(record);
    });
  }

  shuffle(records);
  fs.writeFileSync(outputFile, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  console.log(
    `Wrote ${records.length} records from ${inputFiles.length} files to ${outputFile}`,
  );
}

try {
  main();
} catch (error) {
  console.error(`Failed to arrange data: ${error.message}`);
  process.exitCode = 1;
}
