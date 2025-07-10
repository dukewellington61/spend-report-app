// report.js
import fs from "fs";
import path from "path";
import os from "os";
import csv from "csv-parser";
import ExcelJS from "exceljs";
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
    .replace("\u20AC", "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^0-9.-]/g, "");
  const number = parseFloat(cleaned);
  return isNaN(number) ? 0 : number;
}

function keywordRegexList(keywords) {
  return keywords.map((kw) => new RegExp(kw, "i"));
}

function extractMonthYear(dateStr) {
  const [day, month, year] = dateStr.split(".");
  return `${year}-${month}`;
}

async function loadAndCategorizeCSV(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  const isDKB = lines.some((line) => line.includes("Zahlungsempfänger*in"));
  const headerIndex = lines.findIndex((line) =>
    isDKB
      ? line.includes("Zahlungsempfänger*in") && line.includes("Betrag (€)")
      : line.includes("Umsatz") && line.includes("Buchungstag")
  );
  if (headerIndex === -1) throw new Error("Kein gültiger Header gefunden");

  const csvData = lines.slice(headerIndex).join("\n");
  const categoriesPerMonth = {};
  const excludeRegexes = keywordRegexList(excludeKeywords);

  await new Promise((resolve, reject) => {
    Readable.from([csvData])
      .pipe(csv({ separator: ";" }))
      .on("data", (row) => {
        const amountStr = isDKB ? row["Betrag (€)"] : row["Umsatz in EUR"];
        const bookingDate = isDKB ? row["Buchungsdatum"] : row["Buchungstag"];
        const recipient = isDKB
          ? row["Zahlungsempfänger*in"]
          : row["Buchungstext"];
        const usage = row["Verwendungszweck"] || "-";

        if (!amountStr || !bookingDate || !recipient) return;

        const parsedAmount = parseEuro(amountStr);
        if (parsedAmount >= 0) return;

        const monthKey = extractMonthYear(bookingDate);
        if (!categoriesPerMonth[monthKey]) {
          categoriesPerMonth[monthKey] = {
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
            misc: { matches: [], total: 0 },
            excluded: [],
          };
        }

        const cat = categoriesPerMonth[monthKey];

        if (excludeRegexes.some((re) => re.test(recipient))) {
          cat.excluded.push({
            bookingDate,
            recipient,
            usage,
            raw: amountStr,
            parsed: parsedAmount,
          });
          return;
        }

        let matched = false;
        for (const [name, category] of Object.entries({
          groceries: cat.groceries,
          fixedCosts: cat.fixedCosts,
        })) {
          if (category.keywords.some((regex) => regex.test(recipient))) {
            category.matches.push({
              bookingDate,
              recipient,
              raw: amountStr,
              parsed: parsedAmount,
            });
            category.total += parsedAmount;
            matched = true;
            break;
          }
        }

        if (!matched) {
          cat.misc.matches.push({
            bookingDate,
            recipient,
            raw: amountStr,
            parsed: parsedAmount,
          });
          cat.misc.total += parsedAmount;
        }
      })
      .on("end", resolve)
      .on("error", reject);
  });

  return categoriesPerMonth;
}

async function generateXlsxReport(categoriesPerMonth, outputFile) {
  const workbook = new ExcelJS.Workbook();

  for (const [month, cat] of Object.entries(categoriesPerMonth)) {
    const sheet = workbook.addWorksheet(month);

    sheet.addRow([`🗓️ Bericht für: ${month}`]);
    sheet.addRow([]);

    for (const [catName, data] of Object.entries({
      groceries: cat.groceries,
      fixedCosts: cat.fixedCosts,
      misc: cat.misc,
    })) {
      sheet.addRow([`Kategorie: ${catName}`]);
      sheet.addRow(["Buchungsdatum", "Empfänger", "Betrag"]);
      data.matches.forEach((m) =>
        sheet.addRow([m.bookingDate, m.recipient, m.parsed])
      );
      sheet.addRow([`Summe ${catName}`, "", data.total]);
      sheet.addRow([]);
    }

    sheet.addRow(["Ignorierte Buchungen"]);
    sheet.addRow(["Buchungsdatum", "Empfänger", "Verwendungszweck", "Betrag"]);
    cat.excluded.forEach((e) =>
      sheet.addRow([e.bookingDate, e.recipient, e.usage, e.parsed])
    );
  }

  await workbook.xlsx.writeFile(outputFile);
}

async function main() {
  const folder = path.join(os.homedir(), "Documents", "bank-statements");
  const files = fs
    .readdirSync(folder)
    .filter((f) => f.endsWith(".csv"))
    .map((f) => path.join(folder, f));

  const allCategories = {};

  for (const file of files) {
    const cats = await loadAndCategorizeCSV(file);
    for (const [month, data] of Object.entries(cats)) {
      if (!allCategories[month]) allCategories[month] = data;
      else {
        for (const key of ["groceries", "fixedCosts", "misc"]) {
          allCategories[month][key].matches.push(...data[key].matches);
          allCategories[month][key].total += data[key].total;
        }
        allCategories[month].excluded.push(...data.excluded);
      }
    }
  }

  const outputFile = path.join(folder, "monatsbericht.xlsx");
  await generateXlsxReport(allCategories, outputFile);
  console.log(`📁 Bericht gespeichert: ${outputFile}`);
}

console.log("Running Node version:", process.version);
main();
