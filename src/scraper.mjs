// syllabus scraper

import puppeteer from "puppeteer";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const browser = await puppeteer.launch({
  headless: false,
  args: ["--disable-prompt-on-repost"],
});
const page = await browser.newPage();

page.on("requestfailed", async (request) => {
  console.log(`url: ${request.url()}, errText: ${request.failure().errorText}, method: ${request.method()}`);
  if ("net::ERR_CACHE_MISS" === request.failure().errorText) {
    await page.reload();
  }
});

function attr(ee, name) {
  return page.evaluate((nk, tu) => nk.getAttribute(tu), ee, name);
}
function inner(ee) {
  return page.evaluate((at) => at.innerText, ee);
}

// open the database
const db = await open({
  filename: ":memory:",
  driver: sqlite3.Database,
});

async function findDropdowns() {
  const dd = await page.$$("select");
  const dropDowns = {};
  for (const elem of dd) {
    dropDowns[await attr(elem, "name")] = [];
    for (const le of await elem.$$("option")) {
      dropDowns[await attr(elem, "name")].push({
        value: await attr(le, "value"),
        selected: !!(await attr(le, "selected")),
        name: await inner(le),
      });
    }
  }

  return dropDowns;
}

function waitNav() {
  return page.waitForNavigation();
}

async function click(tagId, wait = false) {
  // clicks button
  await page.click(`input[name=${tagId}]`);
  if (wait) await waitNav();
}

async function dropdown(tagId, value, wait = false) {
  // only use when page refreshes if changed, else not needed
  await page.select(`select[name=${tagId}]`, value);
  if (wait) await waitNav();
}

async function typeInput(tagId, value, wait = false) {
  await page.type(`input[name=${tagId}]`, value);
  if (wait) await waitNav();
}

function init() {
  console.log("Wiping all states");
  return page.goto("https://spica.gakumu.tuat.ac.jp/Syllabus/SearchMain.aspx");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

try {
  // start the session; beginning of our fight with the insanely and unnecessarily stateful website
  await page.goto("https://spica.gakumu.tuat.ac.jp/Syllabus/SearchMain.aspx");
  // response.request.res.responseUrl
  const initialDDs = await findDropdowns();
  // console.log(initialDDs);
  for (const year of initialDDs.ddl_year) {
    // console.log(`Working ${year.name}`);
    for (const faculty of initialDDs.ddl_fac.slice(1)) {
      console.log(`Clicking ${year.name} and ${faculty.name}`);
      await dropdown("ddl_fac", faculty.value);
      await dropdown("ddl_year", year.value, true);
      await click("btnSearch", true);

      // now subject list page was shown, let's do scrape each subjects and paging
      let currentPage = 1,
        knownMax = 2;

      // eslint-disable-next-line no-inner-declarations
      async function reopenOrNextPage(reopen = false) {
        // check current page number
        if (reopen && (await inner(await page.$("tr[align=center]:not([style]) span"))) === `${currentPage}`) {
          return;
        }
        // try to go to the next page
        for (const pageElem of await page.$$("tr[align=center]:not([style]) a")) {
          const num = parseInt((await inner(pageElem)).trim());
          // failed to parse
          if (num !== num) continue;
          // not worth to click (goes back to previous page)
          if (!reopen) {
            if (num <= currentPage) continue;
          } else {
            if (num !== currentPage) continue;
          }

          // voila!
          currentPage = num;
          await pageElem.click();

          // eslint-disable-next-line no-constant-condition
          if (true) await waitNav();
          else {
            // wait until next page is shown (waitNav is unreliable)
            const expectedLeadNumber = `${(currentPage - 1) * 50 + 1}`;
            console.log(`Expecting index of the top to be ${expectedLeadNumber}`);
            // eslint-disable-next-line no-constant-condition
            while (true) {
              try {
                const currentLead = await inner(await page.$("tr[style='background-color:White;'] td"));
                if (currentLead === expectedLeadNumber) {
                  await sleep(3000);
                  break;
                }
              } catch (e) {}
              await sleep(10);
            }
          }

          break;
        }
      }

      do {
        console.log(`Now at page ${currentPage}`);
        await reopenOrNextPage(true);
        // iterate through 詳細 buttons, in weird way!
        let itemsInPage = await page.$$("input[type=submit][value=詳細]");
        const totalInPage = itemsInPage.length;
        for (let i = 0; i < totalInPage; i++) {
          await itemsInPage[i].click();

          // scrape the page and put it into database
          console.log(`Clicking row ${i}`);
          await sleep(1000);

          // go back to previous list page
          await page.goto("https://spica.gakumu.tuat.ac.jp/syllabus/SearchList.aspx");
          await reopenOrNextPage(true);
          // grab handle again...
          // eslint-disable-next-line no-constant-condition
          while (true) {
            itemsInPage = await page.$$("input[type=submit][value=詳細]");
            if (itemsInPage.length === totalInPage) break;

            await sleep(10);
            continue;
          }
        }

        // get maximum number of pages
        for (const pageElem of (await page.$$("tr[align=center]:not([style]) a")).reverse()) {
          const num = parseInt((await inner(pageElem)).trim());
          // failed to parse (次へ or ...)
          if (num !== num) continue;
          // we're already on last page
          if (num <= knownMax) break;
          if (num !== knownMax) console.log(`Updating known maximum: ${knownMax} => ${num}`);

          knownMax = num;
          break;
        }
        await reopenOrNextPage(false);
      } while (currentPage <= knownMax);

      await init();
    }
  }
} catch (e) {
  console.log(e);
} finally {
  await db.close();
  await browser.close();
}
