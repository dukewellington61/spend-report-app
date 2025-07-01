import fs from "fs";
import path from "path";
import os from "os";
import csv from "csv-parser";
import { Readable } from "stream";

import {
  groceryKeywords,
  fixedCostsKeywords,
  excludeKeywords,
} from "./keywords.js";

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

function extractMonthYearFromLines(lines) {
  const regex = /\b(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2})\.(\d{2})\.(\d{4})\b/;
  for (const line of lines) {
    const cells = line.split(";");
    for (const cell of cells) {
      const match = cell.match(regex);
      if (match) {
        const [, , month, year] = match;
        const date = new Date(`${year}-${month}-01`);
        const label = date.toLocaleDateString("de-DE", {
          month: "long",
          year: "numeric",
        });
        const filename = `${year}-${month}`;
        return { label, filename };
      }
    }
  }
  return { label: "Unbekannt", filename: "unbekannt" };
}

function loadAndCategorizeCSV(filePath) {
  return new Promise((resolve, reject) => {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    const { label: reportMonthYear, filename: reportFilename } =
      extractMonthYearFromLines(lines);

    const headerIndex = lines.findIndex(
      (line) =>
        line.includes("Zahlungsempfänger*in") && line.includes("Betrag (€)")
    );
    if (headerIndex === -1) {
      return reject(new Error("❌ Erwartete Header-Zeile nicht gefunden."));
    }

    const csvData = lines.slice(headerIndex).join("\n");

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

    Readable.from([csvData])
      .pipe(csv({ separator: ";" }))
      .on("data", (row) => {
        const recipient = row["Zahlungsempfänger*in"];
        const amountStr = row["Betrag (€)"];
        const usage = row["Verwendungszweck"] || "-";

        if (!recipient || !amountStr) return;

        const parsedAmount = parseEuro(amountStr);

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
        resolve({
          categories,
          excludedEntries,
          reportMonthYear,
          reportFilename,
        })
      )
      .on("error", (err) => reject(err));
  });
}

async function generateReportsFromFolder(folderPath) {
  const files = fs.readdirSync(folderPath).filter((f) => f.endsWith(".csv"));

  for (const file of files) {
    const filePath = path.join(folderPath, file);
    console.log(`\n📄 Verarbeite Datei: ${file}`);

    try {
      const { categories, excludedEntries, reportMonthYear, reportFilename } =
        await loadAndCategorizeCSV(filePath);

      let report = `🗓️ Bericht für: ${reportMonthYear}\n`;

      for (const [name, cat] of Object.entries(categories)) {
        report += `\n📌 Kategorie: ${name} (${cat.matches.length} Treffer)\n`;
        cat.matches.forEach((m, i) => {
          report += `${i + 1}. ${m.recipient} → ${m.raw} → €${m.parsed.toFixed(
            2
          )}\n`;
        });
        report += `\n✅ Gesamtausgaben für ${name}: €${cat.total.toFixed(2)}\n`;
      }

      const totalSum =
        categories.groceries.total +
        categories.fixedCosts.total +
        categories.misc.total;
      report += `\n💰 Gesamt-Ausgaben (alle Kategorien): €${totalSum.toFixed(
        2
      )}\n`;

      if (excludedEntries.length > 0) {
        report += `\n🚫 Ignorierte Buchungen (${excludedEntries.length}):\n`;
        excludedEntries.forEach((e, i) => {
          report += `${i + 1}. ${e.recipient} | ${e.usage} → ${
            e.raw
          } → €${e.parsed.toFixed(2)}\n`;
        });
      }

      const outputFile = `${reportFilename}_report.txt`;
      fs.writeFileSync(outputFile, report, "utf8");
      console.log(`✅ Bericht gespeichert: ${outputFile}`);
    } catch (err) {
      console.error("❌ Fehler beim Verarbeiten:", err);
    }
  }
}

console.log("Running Node version:", process.version);

const bankFolder = path.join(os.homedir(), "Documents", "bank-statements");
generateReportsFromFolder(bankFolder);
