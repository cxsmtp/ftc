// @ts-check
//
// THE /credential PAGE IS A COLUMN. It shares public/verify-pages.css with the
// result pages, whose `main` is a centred flex ROW for their single card; the
// verification page's heading, lead, result card and form are four children,
// and in that row they sat side by side — at a phone's width the result card
// wrapped one letter per line and the form ran off the screen. Geometry, not
// markup: each block sits below the one before it, inside the viewport, at a
// phone's width and a desktop's, with a result card present.
const { test, expect } = require("./isolated-test");
const { BASE } = require("./helpers");

test.use({ baseURL: BASE });

async function geometry(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main.cred-main");
    const kids = [...main.children].map((el) => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), cls: el.className, top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    });
    const m = main.getBoundingClientRect();
    return { kids, main: { left: m.left, right: m.right, width: m.width }, vw: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth };
  });
}

function expectColumn(g) {
  const why = JSON.stringify(g);
  expect(g.kids.length, `PRECONDITION: heading, lead, result card and form: ${why}`).toBe(4);
  for (let i = 1; i < g.kids.length; i++) {
    expect(g.kids[i].top, `${g.kids[i].tag}.${g.kids[i].cls} sits below ${g.kids[i - 1].tag}: ${why}`).toBeGreaterThanOrEqual(g.kids[i - 1].bottom - 1);
  }
  for (const k of g.kids) {
    expect(k.right, `${k.tag} stays inside the viewport: ${why}`).toBeLessThanOrEqual(g.vw + 0.5);
    expect(k.left).toBeGreaterThanOrEqual(-0.5);
    // Each block takes the column's width (less its padding), not a sliver of it.
    expect(k.width, `${k.tag}.${k.cls} spans the column: ${why}`).toBeGreaterThan(g.main.width * 0.8);
  }
  expect(g.scroll, `no sideways scroll: ${why}`).toBeLessThanOrEqual(g.vw);
}

for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`at ${vp.width} px the heading, lead, result card and form stack in one column`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto("/credential");
    await page.fill("#cred-code", "ABCD-EFGH-JKMN");
    await page.fill("#cred-surname", "Nobody");
    await Promise.all([page.waitForNavigation(), page.click(".cred-form button[type=submit]")]);
    await expect(page.locator(".cred-card h2"), "the result card is on the page").toHaveText("No matching certificate");
    const g = await geometry(page);
    expectColumn(g);
    // The card reads as a card: a line of text, not one letter per line.
    const card = g.kids.find((k) => String(k.cls).includes("cred-card"));
    expect(card.height, `the result card is not a tower of letters: ${JSON.stringify(card)}`).toBeLessThan(260);
  });
}
