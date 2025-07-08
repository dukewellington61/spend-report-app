import fs from "fs";
import path from "path";
import os from "os";
import csv from "csv-parser";
import { Readable } from "stream";
import xlsx from "xlsx";

// External keyword definitions
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

function formatMonth(dateStr) {
  const [day, month, year] = dateStr.split(".");
  return `${year}-${month}`; // e.g. 2025-05
}

function getMonthLabel(dateStr) {
  const [day, month, year] = dateStr.split(".");
  const monthNames = [
    "Januar",
    "Februar",
    "März",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
  ];
  return `${monthNames[parseInt(month) - 1]} ${year}`;
}

const excludeRegexes = keywordRegexList(excludeKeywords);

function loadAndSplitCSVByMonth(filePath) {
  return new Promise((resolve, reject) => {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const headerIndex = lines.findIndex(
      (line) =>
        line.includes("Zahlungsempfänger*in") &&
        line.includes("Betrag") &&
        line.includes("Buchungsdatum")
    );

    if (headerIndex === -1) {
      return reject(new Error("❌ Expected headers not found."));
    }

    const csvData = lines.slice(headerIndex).join("\n");
    const monthlyBuckets = {};

    Readable.from([csvData])
      .pipe(csv({ separator: ";" }))
      .on("data", (row) => {
        const date = row["Buchungsdatum"];
        if (!date) return;
        const monthKey = formatMonth(date);
        if (!monthlyBuckets[monthKey]) monthlyBuckets[monthKey] = [];
        monthlyBuckets[monthKey].push(row);
      })
      .on("end", () => resolve(monthlyBuckets))
      .on("error", (err) => reject(err));
  });
}

function categorizeRows(rows) {
  const monthSummary = {
    groceries: {
      keywords: keywordRegexList(groceryKeywords),
      total: 0,
      matches: [],
    },
    fixedCosts: {
      keywords: keywordRegexList(fixedCostsKeywords),
      total: 0,
      matches: [],
    },
    misc: { total: 0, matches: [] },
    excluded: [],
  };

  for (const row of rows) {
    const amountStr = row["Betrag (€)"];
    const recipient = row["Zahlungsempfänger*in"];
    const usage = row["Verwendungszweck"] || "-";
    const parsedAmount = parseEuro(amountStr);

    if (!recipient || !amountStr) continue;

    // Exclude?
    if (excludeRegexes.some((re) => re.test(recipient))) {
      monthSummary.excluded.push({
        recipient,
        usage,
        raw: amountStr,
        parsed: parsedAmount,
      });
      continue;
    }

    if (parsedAmount >= 0) continue;

    let matched = false;
    for (const [catName, cat] of Object.entries(monthSummary)) {
      if (
        cat.keywords?.length &&
        cat.keywords.some((re) => re.test(recipient))
      ) {
        cat.total += parsedAmount;
        cat.matches.push({
          recipient,
          usage,
          raw: amountStr,
          parsed: parsedAmount,
        });
        matched = true;
        break;
      }
    }

    if (!matched) {
      monthSummary.misc.total += parsedAmount;
      monthSummary.misc.matches.push({
        recipient,
        usage,
        raw: amountStr,
        parsed: parsedAmount,
      });
    }
  }

  return monthSummary;
}

async function main() {
  const filePath = path.join(
    os.homedir(),
    "Documents",
    "bank-statements",
    "multi-month.csv"
  );

  if (!fs.existsSync(filePath)) {
    console.error("❌ Datei nicht gefunden:", filePath);
    process.exit(1);
  }

  const monthlyBuckets = await loadAndSplitCSVByMonth(filePath);
  const wb = xlsx.utils.book_new();

  for (const [monthKey, rows] of Object.entries(monthlyBuckets)) {
    const summary = categorizeRows(rows);
    const monthLabel = getMonthLabel(rows[0]["Buchungsdatum"]);

    const data = [
      ["🗓️ Bericht für:", monthLabel],
      [],
      ["📌 Kategorie", "Empfänger", "Verwendungszweck", "Betrag", "Parsed"],
    ];

    for (const [cat, info] of Object.entries(summary)) {
      if (cat === "excluded") continue;
      data.push([], [`Kategorie: ${cat}`]);
      for (const m of info.matches) {
        data.push([cat, m.recipient, m.usage, m.raw, m.parsed]);
      }
      data.push([`Total ${cat}`, "", "", "", info.total.toFixed(2)]);
    }

    data.push([], ["🚫 Ignorierte Buchungen"]);
    for (const e of summary.excluded) {
      data.push(["excluded", e.recipient, e.usage, e.raw, e.parsed]);
    }

    const ws = xlsx.utils.aoa_to_sheet(data);
    xlsx.utils.book_append_sheet(wb, ws, monthLabel.slice(0, 31)); // max Excel sheet name length = 31
  }

  const outputPath = path.join(os.homedir(), "Documents", "monatsbericht.xlsx");
  xlsx.writeFile(wb, outputPath);

  console.log(`✅ Bericht gespeichert als: ${outputPath}`);
}

console.log("Running Node version:", process.version);
main();
