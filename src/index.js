module.exports = createGraphqlFirebaseSource;

const LIMIT = 200;

const createGraphqlDatasource = require('@major-mann/graphql-datasource-base');
const createFirestoreSource = require('@major-mann/datasource-firestore');

async function createGraphqlFirebaseSource({ firestore, definitions, rootTypes, idFieldSelector }) {
    const loadCollection = createFirestoreSource({ firestore });
    const source = await createGraphqlDatasource({
        rootTypes,
        definitions,
        idFieldSelector,
        data: loadCollection
    });
    return source;
}
