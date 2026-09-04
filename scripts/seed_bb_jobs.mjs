import { bulkUpsertJobs } from "./lib/store.mjs";

const jobs = [
  {
    id: "BB-331",
    source: "bb",
    title: "Medical Officer of Bangladesh Bank",
    category: "Human Resources Department 1, Bangladesh Bank",
    orgId: "bb",
    applyUrl: "https://erecruitment.bb.org.bd/onlineapp/new_apply.php?advtno=331",
    pdfUrl: "https://erecruitment.bb.org.bd/career/20260820_bb_67.pdf",
    deadline: "27/09/2026",
    noOfPost: "6",
    salary: "Under National Pay Scale 2015, BDT 22,000-53,060",
    ageCalc: "01/08/2026",
    educationalReq: "MBBS degree from any government approved university. Must be Registered to Bangladesh Medical and Dental Council for Medical Practice",
    payment: "Tk. 200",
    isMatch: false,
    matchedKeywords: []
  },
  {
    id: "BB-330",
    source: "bb",
    title: "Assistant Director (Ex-Cader-Law) of Bangladesh Bank",
    category: "Human Resources Department 1, Bangladesh Bank",
    orgId: "bb",
    applyUrl: "https://erecruitment.bb.org.bd/onlineapp/new_apply.php?advtno=330",
    pdfUrl: "https://erecruitment.bb.org.bd/career/20260818_bb_66.pdf",
    deadline: "20/09/2026",
    noOfPost: "5",
    salary: "Under National Pay Scale 2015, BDT 22000-53060 with other facilities",
    ageCalc: "01/08/2026",
    educationalReq: "Four year Honors/Masters degree in Law with at-least two first division/class in any examination.",
    payment: "Tk. 200",
    isMatch: false,
    matchedKeywords: []
  }
];

await bulkUpsertJobs(jobs);
console.log("Upserted BB jobs successfully!");
