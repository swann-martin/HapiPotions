// This example uses events to detect when new listings are pending approval or
// are published and prints out information about those listings. The sequence
// ID of the last processed event is stored locally so that the event processing
// can continue from the correct point on next execution.

// This dotenv import is required for the `.env` file to be read
require('dotenv').config();
const fs = require('fs');

const sharetribeIntegrationSdk = require('sharetribe-flex-integration-sdk');

// Create rate limit handler for queries.
// NB! If you are using the script in production environment,
// you will need to use sharetribeIntegrationSdk.util.prodQueryLimiterConfig
const queryLimiter = sharetribeIntegrationSdk.util.createRateLimiter(
  sharetribeIntegrationSdk.util.devQueryLimiterConfig
);

// Create rate limit handler for commands.
// NB! If you are using the script in production environment,
// you will need to use sharetribeIntegrationSdk.util.prodCommandLimiterConfig
const commandLimiter = sharetribeIntegrationSdk.util.createRateLimiter(
  sharetribeIntegrationSdk.util.devCommandLimiterConfig
);

const integrationSdk = sharetribeIntegrationSdk.createInstance({
  // These two env vars need to be set in the `.env` file.
  clientId: process.env.LIKE_LISTING_CLIENT_ID,
  clientSecret: process.env.LIKE_LISTING_CLIENT_SECRET,

  // Pass rate limit handlers
  queryLimiter: queryLimiter,
  commandLimiter: commandLimiter,

  // Normally you can just skip setting the base URL and just use the
  // default that the `createInstance` uses. We explicitly set it here
  // for local testing and development.
  baseUrl:
    process.env.SHARETRIBE_INTEGRATION_BASE_URL ||
    'https://flex-integ-api.sharetribe.com',
});

// Start polling from current time on, when there's no stored state
const startTime = new Date();

// Polling interval (in ms) when all events have been fetched. Keeping this at 1
// minute or more is a good idea. In this example we use 10 seconds so that the
// data is printed out without too much delay.
const pollIdleWait = 10000;
// Polling interval (in ms) when a full page of events is received and there may be more
const pollWait = 250;

// File to keep state across restarts. Stores the last seen event sequence ID,
// which allows continuing polling from the correct place
const stateFile = './notify-new-listings.state';

const queryEvents = args => {
  var filter = { eventTypes: 'user/updated' };
  return integrationSdk.events.query({ ...args, ...filter });
};

const saveLastEventSequenceId = sequenceId => {
  try {
    fs.writeFileSync(stateFile, sequenceId.toString());
  } catch (err) {
    throw err;
  }
};

const loadLastEventSequenceId = () => {
  try {
    const data = fs.readFileSync(stateFile);
    return parseInt(data, 10);
  } catch (err) {
    return null;
  }
};

const pollLoop = sequenceId => {
  var params = sequenceId
    ? { startAfterSequenceId: sequenceId }
    : { createdAtStart: startTime };
  queryEvents(params).then(res => {
    const events = res.data.data;
    const lastEvent = events[events.length - 1];
    const fullPage = events.length === res.data.meta.perPage;
    const delay = fullPage ? pollWait : pollIdleWait;
    const lastSequenceId = lastEvent
      ? lastEvent.attributes.sequenceId
      : sequenceId;

    const likesToBeUpdated = groupEvents(events);
    const actions = Object.keys(likesToBeUpdated).map(key =>
      updateListing(key, likesToBeUpdated[key])
    );

    const results = Promise.all(actions);
    results.then(result => {
      result.forEach(el => {
        console.log(
          'listing ID ${el.data.data.id.uuid} updated. It has now ${el.data.data.attributes.publicData.likes} likes'
        );
      });

      if (lastEvent) saveLastEventSequenceId(lastSequenceId);
      setTimeout(() => pollLoop(lastSequenceId), delay);
    });
  });
};

const lastSequenceId = loadLastEventSequenceId();

console.log('Press <CTRL>+C to quit.');
if (lastSequenceId) {
  console.log(
    `Resuming event polling from last seen event with sequence ID ${lastSequenceId}`
  );
} else {
  console.log('No state found or failed to load state.');
  console.log('Starting event polling from current time.');
}

pollLoop(lastSequenceId);

/**
 * Updates the likes of a listing and returns a promise that resolves to the updated listing.
 *
 * @param {string} listingId - The ID of the listing to be updated.
 * @param {number} likeAddition - The number of likes to be added or substracted to the currentLikes of the listing.
 * @return {Promise} A promise that resolves to the updated listing.
 */
const updateListing = (listingId, likeAddition) => {
  return integrationSdk.listings
    .query({
      ids: listingId,
    })
    .then(listings => {
      const listing = listings.data.data[0];
      const currentLikes = listing.attributes.publicData.likes || 0;
      const updateLikes = currentLikes + likeAddition;
      return integrationSdk.listings.update(
        {
          id: listingId,
          publicData: {
            likes: updateLikes,
          },
        },
        { expand: true }
      );
    });
};

// Get the difference between two arrays
const getDifference = (arr1, arr2) => {
  return arr1.filter(x => !arr2.includes(x));
};

// Compare the amount of likes in the previous event to the current one to
// determine which listing was liked or disliked
const getLikedListingId = (previousLikes, currentLikes) => {
  if (previousLikes === null) return currentLikes;
  if (currentLikes === null) return previousLikes;
  else
    return previousLikes.length < currentLikes.length
      ? getDifference(currentLikes, previousLikes)
      : getDifference(previousLikes, currentLikes);
};

const getLikeCount = (previousLikes, currentLikes) => {
  return previousLikes === null || previousLikes.length < currentLikes.length
    ? 1
    : -1;
};

// Reducer returns an object with listing ID's as keys and amount of likes as values
const groupEvents = events => {
  return (likesToBeUpdated = events.reduce((likes, event) => {
    const { resource: user, previousValues } = event.attributes;
    // we might have a user/updated event that doesn't target likedListings
    if (!previousValues.attributes?.profile?.privateData?.likedListings) {
      return {};
    }
    const { likedListings: previouslyLikedListings } =
      previousValues.attributes.profile.privateData || {};
    const likedListings = user.attributes.profile?.privateData?.likedListings;
    const likeCount = getLikeCount(previouslyLikedListings, likedListings);
    const listingId = getLikedListingId(previouslyLikedListings, likedListings);
    likes[listingId] = likes[listingId]
      ? likes[listingId] + likeCount
      : likeCount;
    return likes;
  }, {}));
};
