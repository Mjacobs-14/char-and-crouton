-- Each person has one rating per dish per restaurant, and one want-to-try entry per restaurant.
-- The app already works that way; this makes the database refuse anything else, even when
-- two saves arrive at the same moment.
CREATE UNIQUE INDEX ratings_one_each ON ratings (restaurant_id, dish, lower(rater));
CREATE UNIQUE INDEX wishes_one_each ON wishes (restaurant_id, person);
