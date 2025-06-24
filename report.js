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

// Parse Euro format like "-12,34 €", "1.234,56", or "344"
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

// Extract Monat + Jahr from a line like "01.05.2025 - 29.05.2025"
function extractMonthYearFromLines(lines) {
  const regex = /\b(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2})\.(\d{2})\.(\d{4})\b/;

  for (const line of lines) {
    const cells = line.split(";");
    for (const cell of cells) {
      const match = cell.match(regex);
      if (match) {
        const [, day, month, year] = match;
        const date = new Date(`${year}-${month}-${day}`);
        return date.toLocaleDateString("de-DE", {
          month: "long",
          year: "numeric",
        });
      }
    }
  }
  return null;
}

function loadAndCategorizeCSV(filePath) {
  return new Promise((resolve, reject) => {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const reportMonthYear = extractMonthYearFromLines(lines) || "Unbekannt";

    const headerIndex = lines.findIndex(
      (line) =>
        line.includes("Zahlungsempfänger*in") && line.includes("Betrag (€)")
    );
    if (headerIndex === -1) {
      return reject(new Error("❌ Erwartete Header-Zeile nicht gefunden."));
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

        // Exclude certain transactions
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
      .on("end", () =>
        resolve({ categories, excludedEntries, reportMonthYear })
      )
      .on("error", (err) => reject(err));
  });
}

async function main() {
  const filePath = path.join(
    os.homedir(),
    "Documents",
    "bank-statements",
    "01-12-2024_Umsatzliste_Girokonto.csv"
  );

  if (!fs.existsSync(filePath)) {
    console.error("❌ CSV file not found:", filePath);
    process.exit(1);
  }

  console.log("📂 Scanning CSV and categorizing *negative* expenses...");

  try {
    const { categories, excludedEntries, reportMonthYear } =
      await loadAndCategorizeCSV(filePath);

    let fullReport = `🗓️ Bericht für: ${reportMonthYear}\n`;

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
    console.error("❌ Fehler beim Verarbeiten der CSV:", err);
  }
}

console.log("Running Node version:", process.version);
main();
