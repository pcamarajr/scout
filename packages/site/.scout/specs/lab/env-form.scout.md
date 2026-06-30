---
feature: Environment interpolation
tags: [lab]
---

## A coupon from the environment applies

On the Lab page, type $ENV:LAB_COUPON into the "Coupon code" field and apply it. The page confirms the coupon was applied — assert "Coupon applied" is visible. The literal value stays in the environment, so it never appears in this spec or the recorded script.
