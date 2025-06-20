import fs from "fs";
import path from "path";
import os from "os";
import csv from "csv-parser";
import { Readable } from "stream";

// External keyword definitions
import {
  groceryKeywords,
  fixedCostsKeywords,
  excludeKeywords,
} from "./keywords.js";

// Parse European currency format like "-12,34 €", "1.234,56", or "344"
function parseEuro(value) {
  if (!value) return 0;
  const cleaned = value
    .replace(/\s/g, "")
    .replace("€", "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^0-9.-]/g, "");
  const number = parseFloat(cleaned);
  return isNaN(number) ? 0 : number;
}

function keywordRegexList(keywords) {
  return keywords.map((kw) => new RegExp(kw, "i"));
}

const categories = {
  groceries: {
    keywords: keywordRegexList(groceryKeywords),
    matches: [],
    total: 0,
  },
  fixedCosts: {
    keywords: keywordRegexList(fixedCostsKeywords),
    matches: [],
    total: 0,
  },
  misc: {
    keywords: [],
    matches: [],
    total: 0,
  },
};

const excludeRegexes = keywordRegexList(excludeKeywords);
const excludedEntries = [];

function loadAndCategorizeCSV(filePath) {
  return new Promise((resolve, reject) => {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    const headerIndex = lines.findIndex(
      (line) =>
        line.includes("Zahlungsempfänger*in") && line.includes("Betrag (€)")
    );
    if (headerIndex === -1) {
      return reject(new Error("❌ Could not find expected header row."));
    }

    const csvData = lines.slice(headerIndex).join("\n");

    Readable.from([csvData])
      .pipe(csv({ separator: ";" }))
      .on("data", (row) => {
        const recipient = row["Zahlungsempfänger*in"];
        const amountStr = row["Betrag (€)"];
        const usage = row["Verwendungszweck"] || "-";

        if (!recipient || !amountStr) return;

        const parsedAmount = parseEuro(amountStr);

        // Excluded entries
        if (excludeRegexes.some((regex) => regex.test(recipient))) {
          excludedEntries.push({
            recipient,
            usage,
            raw: amountStr,
            parsed: parsedAmount,
          });
          return;
        }

        if (parsedAmount >= 0) return;

        let matched = false;
        for (const [name, cat] of Object.entries(categories)) {
          if (
            cat.keywords.length &&
            cat.keywords.some((regex) => regex.test(recipient))
          ) {
            cat.matches.push({
              recipient,
              raw: amountStr,
              parsed: parsedAmount,
            });
            cat.total += parsedAmount;
            matched = true;
            break;
          }
        }

        if (!matched) {
          categories.misc.matches.push({
            recipient,
            raw: amountStr,
            parsed: parsedAmount,
          });
          categories.misc.total += parsedAmount;
        }
      })
      .on("end", () => resolve({ categories, excludedEntries }))
      .on("error", (err) => reject(err));
  });
}

async function main() {
  const filePath = path.join(
    os.homedir(),
    "Downloads",
    "20-06-2025_Umsatzliste_Girokonto_DE13120300001015168725.csv"
  );

  if (!fs.existsSync(filePath)) {
    console.error("❌ CSV file not found:", filePath);
    process.exit(1);
  }

  console.log("📂 Scanning CSV and categorizing *negative* expenses...");

  try {
    const { categories, excludedEntries } = await loadAndCategorizeCSV(
      filePath
    );
    let fullReport = "";

    for (const [name, cat] of Object.entries(categories)) {
      console.log(`\n📌 Kategorie: ${name} (${cat.matches.length} Treffer)\n`);
      cat.matches.forEach((m, i) =>
        console.log(
          `${i + 1}. ${m.recipient} → ${m.raw} → €${m.parsed.toFixed(2)}`
        )
      );
      const summaryLine = `\n✅ Gesamtausgaben für ${name}: €${cat.total.toFixed(
        2
      )}\n`;
      console.log(summaryLine);
      fullReport += summaryLine;
    }

    const totalSum =
      categories.groceries.total +
      categories.fixedCosts.total +
      categories.misc.total;

    const combinedLine = `\n💰 Gesamt-Ausgaben (alle Kategorien): €${totalSum.toFixed(
      2
    )}\n`;
    console.log(combinedLine);
    fullReport += combinedLine;

    if (excludedEntries.length > 0) {
      console.log(`\n🚫 Ignorierte Buchungen (${excludedEntries.length}):\n`);
      excludedEntries.forEach((e, i) =>
        console.log(
          `${i + 1}. ${e.recipient} | ${e.usage} → ${
            e.raw
          } → €${e.parsed.toFixed(2)}`
        )
      );
    }

    const outputFile = "monthly_report.txt";
    fs.writeFileSync(outputFile, fullReport);
    console.log(`\n📁 Report saved to: ${outputFile}`);
  } catch (err) {
    console.error("❌ Error:", err);
  }
}

console.log("test commit");

console.log("Running Node version:", process.version);
main();
