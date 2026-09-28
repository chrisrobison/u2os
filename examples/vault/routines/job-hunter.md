---
name: Job hunter
enabled: false          # review, then set to true
when:
  daily: "08:00"
  days: [mon, tue, wed, thu, fri]
skills: [job-hunting]
---
Find and apply for jobs for me, using my job-hunting skill.

1. Search my job boards with jobs.search_jobs for my target roles and
   locations (include remote jobs), and continue once you have the results.
2. Score every result with my job-hunting skill. Apply with jobs.apply to
   each strong match, answering its application questions and writing a
   short cover letter as the skill describes. Record weak matches with
   jobs.skip_job so they are not shown again.
3. Send me one notification: what you applied to, what is waiting for my
   answers or my approval, and anything that needs me.
