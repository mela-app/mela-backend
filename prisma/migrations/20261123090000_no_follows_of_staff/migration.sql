-- App users can't follow Mela's staff accounts (docs/features/social.md,
-- "Staff accounts"): the follows they already have go - and with them live
-- alerts from staff, and the mutual follow private messages need.
DELETE FROM "follows" f
USING "users" follower, "users" followee
WHERE f."followerId" = follower."id"
  AND f."followeeId" = followee."id"
  AND follower."platformRole" = 'USER'
  AND followee."platformRole" <> 'USER';
