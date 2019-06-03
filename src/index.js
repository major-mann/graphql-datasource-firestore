module.exports = createGraphqlFirebaseSource;

const createGraphqlDatasource = require('@major-mann/graphql-datasource-base');
const createFirestoreSource = require('@major-mann/datasource-firestore');

async function createGraphqlFirebaseSource({ firestore, definitions, rootTypes, idFieldSelector, timestamps }) {
    const loadCollection = createFirestoreSource({ firestore });
    const source = await createGraphqlDatasource({
        rootTypes,
        timestamps,
        definitions,
        idFieldSelector,
        data: loadCollection
    });
    return source;
}
