"""End-to-end browser test of the running local stack (see start.sh).

Student: dashboard → instructions → exam room (answers, review marks, refresh,
offline) → submit → result with the expected score.
Admin: overview → AI paper generation (mock provider) → review → assemble →
publish → a second student sees the new paper; PDF upload and indexing;
question creation; students cannot reach admin pages.
Student papers: a student makes their own paper (bank + mock AI), takes it,
sees the result; other students and the admin cannot see it; a student's PDF
upload is shared with everyone.
"""
import json
import os
import re
import sys
import time

from playwright.sync_api import expect, sync_playwright

WORK = os.environ["E2E_WORK"]
SHOTS = os.environ.get("E2E_SHOTS", os.path.join(WORK, "shots"))
BASE = "http://127.0.0.1:4173"
os.makedirs(SHOTS, exist_ok=True)
results = []


def check(cond, msg):
    results.append((bool(cond), msg))
    print(("PASS " if cond else "FAIL ") + msg, flush=True)
    if not cond:
        raise AssertionError(msg)


def new_page(browser, who, **ctx):
    """Signs in as a seeded test user: the local Neon Auth stand-in reads this cookie."""
    context = browser.new_context(**ctx)
    context.add_cookies([{"name": "e2e_user", "value": who, "domain": "127.0.0.1", "path": "/"}])
    page = context.new_page()
    page.on("pageerror", lambda e: print("  [browser error]", e))
    return context, page


def shot(page, name):
    page.screenshot(path=os.path.join(SHOTS, f"{name}.png"), full_page=True)


def student_flow(browser):
    ctx, page = new_page(browser, "student", viewport={"width": 1366, "height": 860})
    page.goto(BASE)
    expect(page.get_by_role("heading", name="Hello, Riya")).to_be_visible()
    expect(page.get_by_role("heading", name="Sample Mixed Practice Test")).to_be_visible()
    shot(page, "01-student-dashboard")
    check(True, "student dashboard lists the published sample test")

    page.get_by_role("link", name="View instructions").click()
    expect(page.get_by_role("heading", name="Paper structure")).to_be_visible()
    shot(page, "02-instructions")
    page.get_by_label("I have read the instructions").check()
    page.get_by_role("button", name="Start test").click()
    expect(page.get_by_role("timer")).to_be_visible()
    check(re.match(r"^(29|30):\d\d$", page.get_by_role("timer").inner_text()) is not None, "timer starts at ~30:00 from server time")

    def opt(label):
        page.locator("label.option").filter(has=page.locator(".lbl", has_text=re.compile(f"^{label}$"))).click()

    opt("B"); page.get_by_role("button", name="Save & Next").click()                       # Q1 correct (+4)
    page.get_by_label("Your answer").fill("6"); page.get_by_role("button", name="Save & Next").click()  # Q2 correct (+4)
    opt("A"); page.get_by_role("button", name="Save & Next").click()                       # Q3 wrong (−1)
    opt("A"); opt("B"); page.get_by_role("button", name="Save & Mark for Review").click()  # Q4 partial (+2)
    page.get_by_role("button", name="Mark for Review & Next").click()                      # Q5 marked, no answer (0)
    expect(page.get_by_text("All answers saved")).to_be_visible(timeout=10000)
    shot(page, "03-exam-room")

    # refresh: answers and palette states come back from the server
    page.reload()
    expect(page.get_by_role("timer")).to_be_visible()
    page.get_by_role("button", name="Physics", exact=True).click()
    expect(page.get_by_role("button", name="Question 1, answered")).to_be_visible()
    expect(page.get_by_role("button", name="Question 4, answered marked")).to_be_visible()
    expect(page.get_by_role("button", name="Question 5, marked")).to_be_visible()
    page.get_by_role("button", name="Question 1, answered").click()
    check(page.locator("label.option.selected .lbl").inner_text() == "B", "saved answer restored after refresh")

    # offline: keep working, answers sync on reconnect
    page.get_by_role("button", name="Chemistry").click()
    ctx.set_offline(True)
    page.evaluate("window.dispatchEvent(new Event('offline'))")
    opt("B"); page.get_by_role("button", name="Save & Next").click()                       # Q6 correct (+4)
    expect(page.get_by_text("You are offline", exact=False).first).to_be_visible()
    shot(page, "04-exam-offline")
    ctx.set_offline(False)
    page.evaluate("window.dispatchEvent(new Event('online'))")
    expect(page.get_by_text("All answers saved")).to_be_visible(timeout=30000)
    check(True, "answer made while offline was saved after reconnecting")

    page.get_by_role("button", name="Submit", exact=True).click()
    expect(page.get_by_role("dialog")).to_be_visible()
    shot(page, "05-submit-confirm")
    page.get_by_role("dialog").get_by_role("button", name="Submit test").click()
    expect(page.get_by_role("heading", name="Test submitted")).to_be_visible()
    page.get_by_role("link", name="See your result").click()
    expect(page.locator(".score-big")).to_contain_text("13")
    check("64" in page.locator(".score-big").inner_text(), "score is 13 / 64 (4+4−1+2+0+4)")
    expect(page.get_by_text("Partially correct (+2)")).to_be_visible()
    shot(page, "06-result")

    ctx.close()


def student_mobile(browser):
    ctx, page = new_page(browser, "student2", viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    page.goto(BASE)
    page.get_by_role("link", name="View instructions").first.click()
    page.get_by_label("I have read the instructions").check()
    page.get_by_role("button", name="Start test").click()
    expect(page.get_by_role("timer")).to_be_visible()
    shot(page, "07-exam-mobile")
    page.get_by_role("button", name="Questions").click()
    expect(page.locator(".palette-pane.open")).to_be_visible()
    shot(page, "08-exam-mobile-palette")
    check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "exam room has no horizontal scroll on a phone")
    ctx.close()


def admin_flow(browser):
    ctx, page = new_page(browser, "admin", viewport={"width": 1440, "height": 900})
    page.goto(BASE + "/admin")
    expect(page.get_by_role("heading", name="Overview")).to_be_visible()
    shot(page, "10-admin-overview")

    # ---- generate a paper (mock provider) for a small custom blueprint
    page.goto(BASE + "/admin/generate")
    expect(page.get_by_text("AI provider: mock")).to_be_visible()
    page.get_by_label("Exam name").fill("Mechanics Sprint")
    page.get_by_label("Total marks").fill("")
    rows = page.locator(".section-row")
    while rows.count() > 2:
        rows.last.get_by_role("button", name="Remove").click()
    r0, r1 = rows.nth(0), rows.nth(1)
    r0.get_by_label("Title").fill("Physics A"); r0.get_by_label("Questions").fill("6")
    r1.get_by_label("Title").fill("Physics B"); r1.get_by_label("Questions").fill("3")
    for r in (r0, r1):
        r.get_by_label("+ marks").fill("4"); r.get_by_label("− marks").fill("1")
    r0.get_by_label("Type").select_option("single")
    r1.get_by_label("Subject").select_option("PHY")
    r1.get_by_label("Type").select_option("integer")
    r0.get_by_role("button", name=re.compile("chapters")).click()
    dlg = page.get_by_role("dialog")
    for ch in ["Kinematics", "Laws of Motion", "Work, Energy and Power"]:
        dlg.get_by_label(ch).check()
    dlg.get_by_role("button", name="Done").click()
    page.get_by_label("Duration (minutes)").fill("45")
    expect(page.locator(".stat", has_text="Total marks")).to_contain_text("36")
    shot(page, "11-generate-form")
    page.get_by_role("button", name="Search bank and estimate").click()
    expect(page.get_by_role("heading", name="1. Generate the missing questions")).to_be_visible(timeout=20000)
    shot(page, "12-generation-plan")
    page.get_by_role("button", name="Generate all remaining").click()
    expect(page.locator(".panel.stat", has_text="Still to generate").locator("b")).to_have_text("0", timeout=90000)
    check(True, "mock generation filled every blueprint gap")
    # mock questions share templates, so the duplicate check flags them and they are approved one by one
    flagged = page.locator(".badge", has_text="possible duplicate").count()
    check(flagged > 0, f"near-duplicate mock questions are flagged for review ({flagged})")
    approve = page.locator("table.data").last.get_by_role("button", name="Approve", exact=True)
    for _ in range(40):
        if approve.count() == 0:
            break
        approve.first.click()
        page.wait_for_timeout(400)
    expect(page.locator(".panel.stat", has_text="Approved and ready").locator("b")).to_have_text("9", timeout=20000)
    shot(page, "13-generation-reviewed")
    page.get_by_role("button", name="Create draft exam").click()
    expect(page.get_by_role("heading", name="Mechanics Sprint")).to_be_visible(timeout=20000)
    shot(page, "14-exam-editor")
    page.get_by_role("button", name="Publish").first.click()
    page.get_by_role("dialog").get_by_role("button", name="Publish").click()
    expect(page.get_by_text("Published v1").or_(page.locator(".badge", has_text="Published")).first).to_be_visible(timeout=20000)
    check(True, "assembled exam published")

    # ---- upload and index a PDF
    pdf_path = os.path.join(WORK, "kinematics-notes.pdf")
    make_pdf(pdf_path)
    page.goto(BASE + "/admin/documents")
    page.get_by_role("button", name="Upload PDF").click()
    page.locator("input[type=file]").set_input_files(pdf_path)
    page.get_by_label("I am authorised").check()
    page.get_by_role("button", name="Upload and index").click()
    expect(page.locator(".badge", has_text="Indexed")).to_be_visible(timeout=60000)
    shot(page, "15-documents")
    check(True, "PDF extracted, chunked and indexed in the browser")

    # ---- write a question by hand
    page.goto(BASE + "/admin/questions/new")
    page.get_by_label("Subject").select_option(label="Mathematics")
    page.get_by_label("Chapter").select_option(label="Binomial Theorem")
    page.get_by_label("Question type").select_option("integer")
    page.locator("textarea").first.fill("The number of terms in the expansion of $(1+x)^{12}$ is ____.")
    page.get_by_label("Correct answer").fill("13")
    page.get_by_label("Step-by-step solution").fill("A binomial $(a+b)^n$ has $n+1$ terms, so there are $13$ terms.")
    shot(page, "16-question-editor")
    page.get_by_role("button", name="Save and approve").click()
    expect(page.get_by_text("Question saved and approved")).to_be_visible(timeout=10000)
    check(True, "admin created and approved a question")
    page.goto(BASE + "/admin/questions")
    shot(page, "17-question-bank")
    page.goto(BASE + "/admin/settings")
    shot(page, "18-settings")
    ctx.close()


def student_sees_new_exam_and_no_admin(browser):
    ctx, page = new_page(browser, "student2", viewport={"width": 1280, "height": 800})
    page.goto(BASE)
    expect(page.get_by_role("heading", name="Mechanics Sprint")).to_be_visible()
    check(True, "students see the newly published exam")
    check(page.get_by_role("link", name="Admin").count() == 0, "students have no admin link")
    page.goto(BASE + "/admin/questions")
    expect(page.get_by_role("heading", name=re.compile("Hello|Your tests"))).to_be_visible()
    check("/admin" not in page.url, "students are redirected away from admin pages")
    ctx.close()


def student_makes_own_paper(browser):
    ctx, page = new_page(browser, "student2", viewport={"width": 1280, "height": 860})
    page.goto(BASE + "/make")
    expect(page.get_by_role("heading", name="Make a paper")).to_be_visible()
    expect(page.get_by_text("AI is in demo mode")).to_be_visible(timeout=15000)
    page.get_by_label("Paper name").fill("My Kinematics Drill")
    rows = page.locator(".section-row")
    expect(rows).to_have_count(3)
    while rows.count() > 1:
        rows.last.get_by_role("button", name="Remove").click()
    rows.nth(0).get_by_label("Subject").select_option("PHY")
    rows.nth(0).get_by_label("Questions").fill("4")
    rows.nth(0).get_by_role("button", name=re.compile("chapters")).click()
    page.get_by_role("dialog").get_by_label("Kinematics").check()
    page.get_by_role("dialog").get_by_role("button", name="Done").click()
    page.get_by_label("Duration (minutes)").fill("20")
    # (a full-page screenshot here can leave the sticky header mid-page and swallow the click)
    page.screenshot(path=os.path.join(SHOTS, "20-make-paper.png"))
    page.get_by_role("button", name="Make my paper").click()
    try:
        expect(page.get_by_role("heading", name="Paper structure")).to_be_visible(timeout=120000)
    except Exception:
        shot(page, "20b-make-paper-failed")
        print("  page text:", page.locator("body").inner_text()[:800])
        raise
    check("/exam/" in page.url, "the student's paper was made (bank + AI) and opened")
    shot(page, "21-own-paper-instructions")
    page.get_by_label("I have read the instructions").check()
    page.get_by_role("button", name="Start test").click()
    expect(page.get_by_role("timer")).to_be_visible()
    page.locator("label.option").first.click()
    page.get_by_role("button", name="Save & Next").click()
    expect(page.get_by_text("All answers saved")).to_be_visible(timeout=10000)
    page.get_by_role("button", name="Submit", exact=True).click()
    page.get_by_role("dialog").get_by_role("button", name="Submit test").click()
    expect(page.get_by_role("heading", name="Test submitted")).to_be_visible()
    page.get_by_role("link", name="See your result").click()
    expect(page.locator(".score-big")).to_contain_text("16")
    check(True, "the student sees their own result and solutions straight away")
    shot(page, "22-own-paper-result")
    page.goto(BASE)
    expect(page.get_by_role("heading", name="My papers")).to_be_visible()
    expect(page.locator(".exam-item", has_text="My Kinematics Drill")).to_be_visible()
    check(True, "the paper is listed under My papers")

    # share a PDF with everyone
    pdf_path = os.path.join(WORK, "arjun-notes.pdf")
    make_pdf(pdf_path)
    page.goto(BASE + "/material")
    page.get_by_role("button", name="Upload PDF").click()
    page.locator("input[type=file]").set_input_files(pdf_path)
    page.get_by_label("Title").fill("Arjun's motion notes")
    page.get_by_label("I have the right to share").check()
    page.get_by_role("button", name="Upload and index").click()
    expect(page.locator("tr", has_text="Arjun's motion notes").locator(".badge", has_text="Indexed")).to_be_visible(timeout=60000)
    check(True, "a student uploaded and indexed a PDF")
    shot(page, "23-shared-material")
    ctx.close()

    # another student: sees the shared PDF, not the private paper
    ctx, page = new_page(browser, "student", viewport={"width": 1280, "height": 860})
    page.goto(BASE)
    expect(page.get_by_role("heading", name="My papers")).to_be_visible()
    check(page.get_by_text("My Kinematics Drill").count() == 0, "other students cannot see someone else's paper")
    page.goto(BASE + "/material")
    row = page.locator("tr", has_text="Arjun's motion notes")
    expect(row).to_be_visible()
    check(row.get_by_role("button", name="Delete").count() == 0, "shared material is visible to everyone but only its uploader can delete it")
    page.goto(BASE + "/make")
    expect(page.get_by_label("Arjun's motion notes")).to_be_visible(timeout=15000)
    check(True, "everyone can pick shared material when making a paper")
    ctx.close()

    # phone: the top navigation fits
    ctx, page = new_page(browser, "student", viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    page.goto(BASE)
    expect(page.get_by_role("heading", name="My papers")).to_be_visible()
    check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "dashboard has no horizontal scroll on a phone")
    shot(page, "24-dashboard-mobile")
    ctx.close()

    # admin: no trace of the private paper or its marks
    ctx, page = new_page(browser, "admin", viewport={"width": 1440, "height": 900})
    page.goto(BASE + "/admin")
    expect(page.get_by_role("heading", name="Overview")).to_be_visible()
    expect(page.locator(".panel.stat", has_text="Papers students made")).to_contain_text("1")
    check(page.get_by_text("My Kinematics Drill").count() == 0, "admin overview does not show the student's paper or score")
    page.goto(BASE + "/admin/exams")
    expect(page.get_by_text("Mechanics Sprint").first).to_be_visible()
    check(page.get_by_text("My Kinematics Drill").count() == 0, "admin exam list does not include students' own papers")
    ctx.close()


def make_pdf(path):
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    c = canvas.Canvas(path, pagesize=A4)
    body = ("When a body moves with uniform acceleration a, its velocity after time t is v = u + at and the displacement is "
            "s = ut + at^2/2. These equations hold only when the acceleration is constant in magnitude and direction. ")
    for page in range(1, 4):
        y = 800
        c.setFont("Helvetica-Bold", 14)
        c.drawString(50, y, f"Chapter {page} Motion in a Straight Line" if page == 1 else f"{page}.1 Worked ideas")
        c.setFont("Helvetica", 10)
        y -= 30
        for i in range(30):
            c.drawString(50, y, (body * 2)[i * 3: i * 3 + 95])
            y -= 14
            if i % 8 == 7:
                y -= 14
        c.showPage()
    c.save()


with sync_playwright() as p:
    browser = p.chromium.launch()
    failed = False
    for fn in (student_flow, student_mobile, admin_flow, student_sees_new_exam_and_no_admin, student_makes_own_paper):
        try:
            fn(browser)
        except Exception as e:  # keep going so we see every failure
            failed = True
            print(f"FAIL {fn.__name__}: {e}", flush=True)
    browser.close()
    print(f"\n{sum(ok for ok, _ in results)} checks passed, {sum(not ok for ok, _ in results)} failed")
    sys.exit(1 if failed else 0)
